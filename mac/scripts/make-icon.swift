// Same brand artwork as ios/scripts/make-icon.swift.
// Usage: swift mac/scripts/make-icon.swift <output.png>
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let side = 1024
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
guard let context = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8,
                              bytesPerRow: side * 4, space: colorSpace,
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
    fatalError("Couldn't create the icon context")
}
func color(_ hex: UInt) -> CGColor {
    CGColor(colorSpace: colorSpace, components: [
        CGFloat((hex >> 16) & 255) / 255,
        CGFloat((hex >> 8) & 255) / 255,
        CGFloat(hex & 255) / 255, 1
    ])!
}
context.setFillColor(color(0x12141A))
context.fill(CGRect(x: 0, y: 0, width: side, height: side))
context.translateBy(x: 0, y: CGFloat(side))
context.scaleBy(x: CGFloat(side) / 72, y: -CGFloat(side) / 72)
context.setStrokeColor(color(0xFFFFFF))
context.setLineWidth(4)
context.setLineCap(.round)
context.move(to: CGPoint(x: 20, y: 50))
context.addCurve(to: CGPoint(x: 52, y: 50), control1: CGPoint(x: 20, y: 26), control2: CGPoint(x: 52, y: 26))
context.strokePath()
for (x, y, radius, hex) in [(20.0, 50.0, 6.0, UInt(0xFFFFFF)), (52.0, 50.0, 6.0, UInt(0x4B3AF0)), (36.0, 32.0, 3.5, UInt(0x4B3AF0))] {
    context.setFillColor(color(hex))
    context.fillEllipse(in: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2))
}
guard CommandLine.arguments.count == 2 else { fatalError("Expected output PNG path") }
let output = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = context.makeImage(),
      let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fatalError("Couldn't create the PNG destination")
}
CGImageDestinationAddImage(destination, image, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("Couldn't write the PNG") }
print("Generated \(output.path)")
