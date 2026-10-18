import AppKit

let destination = URL(fileURLWithPath: CommandLine.arguments[1])
let image = NSImage(size: NSSize(width: 1024, height: 1024))
image.lockFocus()
NSColor.clear.setFill()
NSRect(x: 0, y: 0, width: 1024, height: 1024).fill()
let card = NSBezierPath(roundedRect: NSRect(x: 80, y: 80, width: 864, height: 864), xRadius: 192, yRadius: 192)
let gradient = NSGradient(starting: NSColor(calibratedRed: 0.84, green: 0.62, blue: 0.39, alpha: 1), ending: NSColor(calibratedRed: 0.71, green: 0.43, blue: 0.25, alpha: 1))!
gradient.draw(in: card, angle: -90)
// Original geometric chat bubbles drawn with AppKit paths; no SF Symbols or
// provider logos are embedded in the distributable app icon.
func drawBubble(_ frame: NSRect, color: NSColor, tailOnLeft: Bool) {
    color.setFill()
    let shape = NSBezierPath(roundedRect: frame, xRadius: 54, yRadius: 54)
    let tail = NSBezierPath()
    let x = tailOnLeft ? frame.minX + 70 : frame.maxX - 70
    tail.move(to: NSPoint(x: x - 35, y: frame.minY + 20))
    tail.line(to: NSPoint(x: x + 35, y: frame.minY + 20))
    tail.line(to: NSPoint(x: x + (tailOnLeft ? -32 : 32), y: frame.minY - 58))
    tail.close()
    shape.append(tail)
    shape.fill()
}
drawBubble(NSRect(x: 390, y: 432, width: 395, height: 292),
           color: NSColor(calibratedWhite: 1, alpha: 0.50), tailOnLeft: false)
drawBubble(NSRect(x: 224, y: 304, width: 448, height: 308),
           color: NSColor(calibratedRed: 1, green: 0.98, blue: 0.93, alpha: 1), tailOnLeft: true)
NSColor(calibratedRed: 0.74, green: 0.46, blue: 0.28, alpha: 1).setFill()
for x in [340, 432, 524] {
    NSBezierPath(ovalIn: NSRect(x: x, y: 440, width: 32, height: 32)).fill()
}
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: destination)
