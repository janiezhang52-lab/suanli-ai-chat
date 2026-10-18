import AppKit
import WebKit
import Foundation
import CoreFoundation

private let applicationName = "算力有限责任公司"
private let servicePort: Int = {
    guard let value = ProcessInfo.processInfo.environment["AI_GROUP_PORT"],
          let port = Int(value), (1024...65535).contains(port) else { return 47631 }
    return port
}()
private let serviceURL = URL(string: "http://127.0.0.1:\(servicePort)/")!
// An explicit data directory is also used by isolated release verification.
// Never reuse the personal WebKit cache when an alternate directory is selected.
private let dataDirectoryOverride: URL? = {
    guard let path = ProcessInfo.processInfo.environment["AI_GROUP_DATA_DIR"],
          path.hasPrefix("/"), !path.isEmpty else { return nil }
    return URL(fileURLWithPath: path, isDirectory: true)
}()

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

private enum Health {
    case ready, notListening, unavailable(String)
}

private struct PendingDownload {
    let temporaryURL: URL
    let destinationURL: URL
}

private final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
    WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var content: NSView!
    private var statusView: NSStackView!
    private var statusTitle: NSTextField!
    private var statusDetail: NSTextField!
    private var spinner: NSProgressIndicator!
    private var retryButton: NSButton!
    private var startupTask: Task<Void, Never>?
    private var child: Process?
    private var childLog: FileHandle?
    private var quitting = false
    private var waitingToQuit = false
    private var hasLoaded = false
    private var popupViews: [WKWebView] = []
    private var downloads: [ObjectIdentifier: PendingDownload] = [:]
    private let redirectDelegate = NoRedirect()
    private lazy var healthSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 1.5
        configuration.timeoutIntervalForResource = 2
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.connectionProxyDictionary = [:]
        return URLSession(configuration: configuration, delegate: redirectDelegate, delegateQueue: nil)
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        startOrConnect()
        NSApp.activate(ignoringOtherApps: true)
    }

    private func buildMenu() {
        let menu = NSMenu()
        let applicationItem = NSMenuItem()
        let applicationMenu = NSMenu(title: applicationName)
        applicationMenu.addItem(withTitle: "关于\(applicationName)", action: #selector(showAbout), keyEquivalent: "")
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(withTitle: "隐藏\(applicationName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(withTitle: "退出\(applicationName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        applicationItem.submenu = applicationMenu
        menu.addItem(applicationItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        menu.addItem(editItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "刷新", action: #selector(refresh), keyEquivalent: "r")
        windowMenu.addItem(withTitle: "重试连接", action: #selector(retry), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        menu.addItem(windowItem)
        NSApp.windowsMenu = windowMenu
        NSApp.mainMenu = menu
    }

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = applicationName
        window.minSize = NSSize(width: 900, height: 620)
        window.backgroundColor = NSColor(red: 0.98, green: 0.975, blue: 0.96, alpha: 1)
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName(dataDirectoryOverride == nil ? "AIGroupChatMainWindow" : "AIGroupChatVerificationWindow")
        window.center()

        content = NSView()
        window.contentView = content
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataDirectoryOverride == nil ? .default() : .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isHidden = true
        content.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.topAnchor.constraint(equalTo: content.topAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor)
        ])

        statusTitle = NSTextField(labelWithString: "正在打开群聊…")
        statusTitle.font = .systemFont(ofSize: 21, weight: .semibold)
        statusTitle.alignment = .center
        statusDetail = NSTextField(wrappingLabelWithString: "马上就好。")
        statusDetail.font = .systemFont(ofSize: 14)
        statusDetail.textColor = .secondaryLabelColor
        statusDetail.alignment = .center
        spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .regular
        retryButton = NSButton(title: "重试", target: self, action: #selector(retry))
        retryButton.bezelStyle = .rounded
        statusView = NSStackView(views: [spinner, statusTitle, statusDetail, retryButton])
        statusView.orientation = .vertical
        statusView.spacing = 18
        statusView.alignment = .centerX
        statusView.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(statusView)
        NSLayoutConstraint.activate([
            statusView.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            statusView.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            statusView.widthAnchor.constraint(equalToConstant: 480)
        ])
        window.makeKeyAndOrderFront(nil)
    }

    private func showStatus(_ title: String, detail: String, busy: Bool) {
        statusTitle.stringValue = title
        statusDetail.stringValue = detail
        statusView.isHidden = false
        webView.isHidden = true
        retryButton.isHidden = busy
        spinner.isHidden = !busy
        busy ? spinner.startAnimation(nil) : spinner.stopAnimation(nil)
    }

    private func probeService() async -> Health {
        do {
            var request = URLRequest(url: serviceURL.appendingPathComponent("api/state"))
            request.timeoutInterval = 1.5
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let (data, response) = try await healthSession.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  data.count < 700 * 1024,
                  let record = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  record["ownerKey"] as? String == "local-device",
                  let revision = record["revision"] as? NSNumber,
                  CFGetTypeID(revision) != CFBooleanGetTypeID(),
                  revision.doubleValue >= 0,
                  revision.doubleValue <= 9_007_199_254_740_991,
                  floor(revision.doubleValue) == revision.doubleValue else {
                return .unavailable("本机连接被其他程序占用，或群聊数据暂时无法读取。请关闭占用程序后重试。")
            }
            let emptyInitialState = record["state"] is NSNull && revision.intValue == 0
            let state = record["state"] as? [String: Any]
            let validState = state?["agents"] is [[String: Any]] && state?["rooms"] is [[String: Any]]
            guard emptyInitialState || validState else {
                return .unavailable("本机连接被其他程序占用，或群聊数据暂时无法读取。请关闭占用程序后重试。")
            }
            return .ready
        } catch let error as URLError where error.code == .cannotConnectToHost {
            return .notListening
        } catch {
            return .unavailable("暂时无法确认本机群聊是否正常运行。请稍后重试；已有程序和聊天记录不会被修改。")
        }
    }

    private func startOrConnect() {
        startupTask?.cancel()
        showStatus("正在打开群聊…", detail: "马上就好。", busy: true)
        startupTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let initial = await self.probeService()
            guard !Task.isCancelled, !self.quitting else { return }
            switch initial {
            case .ready:
                // An isolated verification instance must never reuse another
                // process, even if that process happens to be a real chat app.
                if dataDirectoryOverride != nil && self.child?.isRunning != true {
                    self.showStatus("验收地址已被使用", detail: "请改用空闲的 AI_GROUP_PORT 后重开；不会载入已有服务的数据。", busy: false)
                    return
                }
                self.loadGroup()
                return
            case .unavailable(let message):
                self.showStatus("群聊暂时打不开", detail: message, busy: false)
                return
            case .notListening:
                break
            }
            do {
                if self.child?.isRunning != true { try self.launchBackend() }
            } catch {
                self.showStatus("群聊暂时打不开", detail: "本机服务未能启动。请确认 App 安装完整，然后点重试。", busy: false)
                return
            }
            let deadline = Date().addingTimeInterval(20)
            while Date() < deadline, !Task.isCancelled, !self.quitting {
                let health = await self.probeService()
                guard !Task.isCancelled, !self.quitting else { return }
                switch health {
                case .ready:
                    self.loadGroup()
                    return
                case .unavailable(let message):
                    self.showStatus("群聊暂时打不开", detail: message, busy: false)
                    return
                case .notListening:
                    if self.child?.isRunning != true {
                        self.showStatus("群聊暂时打不开", detail: "本机服务没有成功启动。请点重试；聊天记录仍然保留。", busy: false)
                        return
                    }
                }
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
            guard !Task.isCancelled, !self.quitting else { return }
            self.showStatus("打开时间有点久", detail: "本机服务还没有就绪。可以稍后重试，或退出 App 后重新打开。", busy: false)
        }
    }

    private func launchBackend() throws {
        guard let resources = Bundle.main.resourceURL else {
            throw CocoaError(.fileNoSuchFile)
        }
        let manager = FileManager.default
        let backend = resources.appendingPathComponent("backend", isDirectory: true)
        let executable = resources.appendingPathComponent("runtime/node")
        let script = backend.appendingPathComponent("scripts/start.mjs")
        guard manager.isExecutableFile(atPath: executable.path), manager.fileExists(atPath: script.path) else {
            throw CocoaError(.fileNoSuchFile)
        }
        let support = dataDirectoryOverride ?? manager.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/\(applicationName)", isDirectory: true)
        let logDirectory = dataDirectoryOverride?.appendingPathComponent("logs", isDirectory: true) ?? manager.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/\(applicationName)", isDirectory: true)
        try manager.createDirectory(at: logDirectory, withIntermediateDirectories: true,
                                    attributes: [.posixPermissions: 0o700])
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: logDirectory.path)
        let logURL = logDirectory.appendingPathComponent("server.log")
        // Backend output is deliberately limited to generic startup/failure messages. Keep
        // one bounded previous log without ever printing authorization URLs in this wrapper.
        if let attributes = try? manager.attributesOfItem(atPath: logURL.path),
           let size = attributes[.size] as? NSNumber, size.intValue >= 2 * 1024 * 1024 {
            let previous = logDirectory.appendingPathComponent("server.previous.log")
            if manager.fileExists(atPath: previous.path) { try manager.removeItem(at: previous) }
            try manager.moveItem(at: logURL, to: previous)
            try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: previous.path)
        }
        if !manager.fileExists(atPath: logURL.path) {
            guard manager.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                throw CocoaError(.fileWriteNoPermission)
            }
        }
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: logURL.path)
        childLog?.closeFile()
        let log = try FileHandle(forWritingTo: logURL)
        log.seekToEndOfFile()
        let process = Process()
        process.executableURL = executable
        process.arguments = [script.path]
        process.currentDirectoryURL = backend
        var environment = ProcessInfo.processInfo.environment
        environment["AI_GROUP_DATA_DIR"] = support.path
        environment["NODE_ENV"] = "production"
        environment["AI_GROUP_PORT"] = String(servicePort)
        process.environment = environment
        process.standardOutput = log
        process.standardError = log
        process.standardInput = FileHandle.nullDevice
        process.terminationHandler = { [weak self] terminatedProcess in
            DispatchQueue.main.async {
                guard let self, self.child === terminatedProcess else { return }
                self.childLog?.closeFile()
                self.childLog = nil
                if self.waitingToQuit {
                    self.waitingToQuit = false
                    NSApp.reply(toApplicationShouldTerminate: true)
                } else if self.hasLoaded && !self.quitting {
                    self.showStatus("连接已断开", detail: "本机服务已停止。点重试即可重新打开，聊天记录仍然保留。", busy: false)
                }
            }
        }
        try process.run()
        childLog = log
        child = process
    }

    private func loadGroup() {
        hasLoaded = false
        var request = URLRequest(url: serviceURL)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        webView.load(request)
    }

    @objc private func retry() { startOrConnect() }
    @objc private func refresh() {
        if webView.isHidden { startOrConnect() } else { webView.reload() }
    }
    @objc private func showAbout() {
        let alert = NSAlert()
        alert.messageText = applicationName
        alert.informativeText = "双击 App 就能打开自己的 AI 群聊。\n\n聊天记录保存在这台 Mac 上。关闭窗口会退出 App；下次打开可以继续聊。"
        alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        quitting = true
        startupTask?.cancel()
        for popup in popupViews { popup.stopLoading() }
        guard let process = child, process.isRunning else { return .terminateNow }
        waitingToQuit = true
        process.terminate()
        // Only this App's own child is eligible for termination; a reused service is never touched.
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self, weak process] in
            guard let self, self.waitingToQuit else { return }
            if let process, process.isRunning { kill(process.processIdentifier, SIGKILL) }
            self.waitingToQuit = false
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    private func isLocal(_ url: URL) -> Bool {
        url.scheme == "http" && url.host == "127.0.0.1" && url.port == servicePort && url.user == nil && url.password == nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.shouldPerformDownload {
            guard isLocal(url) || url.scheme == "blob" else { decisionHandler(.cancel); return }
            decisionHandler(.download)
        } else if isLocal(url) || url.absoluteString == "about:blank" || url.scheme == "blob" {
            decisionHandler(.allow)
        } else if url.scheme == "https" || url.scheme == "http" {
            decisionHandler(.cancel)
            NSWorkspace.shared.open(url)
            if webView !== self.webView { discardPopup(webView) }
        } else {
            decisionHandler(.cancel)
            if webView !== self.webView { discardPopup(webView) }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if !navigationResponse.canShowMIMEType {
            decisionHandler(.download)
        } else { decisionHandler(.allow) }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard navigationAction.targetFrame == nil, let url = navigationAction.request.url else { return nil }
        guard isLocal(url) || url.scheme == "blob" else {
            if url.scheme == "https" || url.scheme == "http" { NSWorkspace.shared.open(url) }
            return nil
        }
        // Let WebKit load the original request in a secondary view, preserving its same-origin
        // Referer for the sign-in endpoint while the visible group chat stays in place.
        let popup = WKWebView(frame: .zero, configuration: configuration)
        popup.navigationDelegate = self
        popup.uiDelegate = self
        popupViews.append(popup)
        return popup
    }

    private func discardPopup(_ popup: WKWebView) {
        DispatchQueue.main.async { [weak self, weak popup] in
            guard let self, let popup else { return }
            self.popupViews.removeAll { $0 === popup }
        }
    }
    func webViewDidClose(_ webView: WKWebView) { discardPopup(webView) }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === self.webView {
            hasLoaded = true
            statusView.isHidden = true
            spinner.stopAnimation(nil)
            webView.isHidden = false
            window.makeFirstResponder(webView)
        } else { discardPopup(webView) }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        navigationFailed(webView, error: error)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        navigationFailed(webView, error: error)
    }
    private func navigationFailed(_ failedView: WKWebView, error: Error) {
        if failedView !== webView { discardPopup(failedView); return }
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        showStatus("群聊暂时打不开", detail: "页面没有成功载入。点重试即可重新连接。", busy: false)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView === self.webView {
            showStatus("页面需要重新打开", detail: "点重试即可继续。已经保存的聊天记录仍然保留。", busy: false)
        } else { discardPopup(webView) }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.title = "导出聊天记录"
        panel.prompt = "保存"
        panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { [weak self] result in
            guard let self, result == .OK, let destination = panel.url else {
                completionHandler(nil)
                return
            }
            let temporary = FileManager.default.temporaryDirectory
                .appendingPathComponent("ai-group-export-\(UUID().uuidString)")
            self.downloads[ObjectIdentifier(download)] = PendingDownload(temporaryURL: temporary, destinationURL: destination)
            completionHandler(temporary)
        }
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard let pending = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        let manager = FileManager.default
        if manager.fileExists(atPath: pending.destinationURL.path) {
            let alert = NSAlert()
            alert.messageText = "替换已有文件？"
            alert.informativeText = "“\(pending.destinationURL.lastPathComponent)”已经存在。替换后，原文件的内容会被这份聊天记录覆盖。"
            alert.addButton(withTitle: "替换")
            alert.addButton(withTitle: "取消")
            alert.beginSheetModal(for: window) { [weak self] response in
                if response == .alertFirstButtonReturn { self?.finishDownload(pending, replacing: true) }
                else { try? manager.removeItem(at: pending.temporaryURL) }
            }
        } else { finishDownload(pending, replacing: false) }
    }
    private func finishDownload(_ pending: PendingDownload, replacing: Bool) {
        do {
            let manager = FileManager.default
            if replacing {
                _ = try manager.replaceItemAt(pending.destinationURL, withItemAt: pending.temporaryURL)
            } else { try manager.moveItem(at: pending.temporaryURL, to: pending.destinationURL) }
        } catch {
            try? FileManager.default.removeItem(at: pending.temporaryURL)
            showExportError()
        }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        guard let pending = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        try? FileManager.default.removeItem(at: pending.temporaryURL)
        if (error as NSError).code != NSURLErrorCancelled { showExportError() }
    }
    private func showExportError() {
        let alert = NSAlert()
        alert.messageText = "聊天记录没有导出成功"
        alert.informativeText = "请再试一次，并选择可以保存文件的位置。"
        alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window)
    }
}

let application = NSApplication.shared
private let applicationDelegate = AppDelegate()
application.setActivationPolicy(.regular)
application.delegate = applicationDelegate
application.run()
