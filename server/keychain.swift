import Foundation
import Security

// Only a random encryption key is stored here. No secret is passed in argv.
let service = "com.kaigehui.local.credential-encryption"
let account = "v1"
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecReturnData as String: true,
    kSecMatchLimit as String: kSecMatchLimitOne
]
var result: CFTypeRef?
let found = SecItemCopyMatching(query as CFDictionary, &result)
var key: Data
if found == errSecSuccess, let existing = result as? Data, existing.count == 32 {
    key = existing
} else if found == errSecItemNotFound {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { exit(3) }
    key = Data(bytes)
    let item: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecAttrLabel as String: "开个会本机版 · 凭据加密",
        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        kSecValueData as String: key
    ]
    let added = SecItemAdd(item as CFDictionary, nil)
    if added == errSecDuplicateItem {
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let existing = result as? Data, existing.count == 32 else { exit(4) }
        key = existing
    } else if added != errSecSuccess { exit(5) }
} else { exit(6) }
FileHandle.standardOutput.write(key)
