import Charts
import SwiftUI

struct ConversationDiagram: View {
    let source: String

    var body: some View {
        switch ConversationDiagramModel(source) {
        case .pie(let title, let slices):
            VStack(alignment: .leading, spacing: 8) {
                if !title.isEmpty { Text(title).font(.headline) }
                Chart(Array(slices.enumerated()), id: \.offset) { item in
                    SectorMark(angle: .value("Value", item.element.value))
                        .foregroundStyle(by: .value("Category", item.element.label))
                        .accessibilityLabel(item.element.label)
                        .accessibilityValue(item.element.value.formatted())
                }
                .chartLegend(position: .bottom, alignment: .leading)
                .frame(minHeight: 180)
            }
        case .xy(let model):
            DiagramXYView(model: model)
        case .flow(let direction, let nodes, let edges):
            DiagramFlowView(direction: direction, nodes: nodes, edges: edges)
        case nil:
            DisclosureGroup("Diagram source") {
                ScrollView(.horizontal) {
                    Text(verbatim: source).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                }
            }
        }
    }
}

private struct DiagramXYView: View {
    let model: ConversationDiagramModel.XYChart
    private let colors: [Color] = [.blue, .orange, .teal, .purple, .pink, .indigo, .green, .brown]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !model.title.isEmpty { Text(model.title).font(.headline) }
            Group {
                if let domain = model.yRange { plot.chartYScale(domain: domain) } else { plot }
            }
            .frame(height: 205)
            ForEach(model.series.indices, id: \.self) { index in
                if let name = model.series[index].name {
                    Label {
                        Text(name)
                    } icon: {
                        Circle().fill(colors[index]).frame(width: 8, height: 8)
                    }.font(.caption)
                }
            }
        }
    }

    @ViewBuilder private var plot: some View {
        if let labels = model.categories {
            chart { labels[$0] }.chartXScale(domain: labels)
        } else {
            let count = model.series[0].values.count
            let domain = model.xRange ?? (count == 1 ? 0.5...1.5 : 1...Double(count))
            chart(xValue: model.x(at:)).chartXScale(
                domain: domain, range: .plotDimension(startPadding: 14, endPadding: 14))
        }
    }

    private func chart<X: Plottable>(xValue: @escaping (Int) -> X) -> some View {
        let baseline = model.yRange.map { min(max($0.lowerBound, 0), $0.upperBound) } ?? 0
        let groupBars = model.series.filter { $0.kind == .bar }.count > 1
        return Chart {
            ForEach(model.series.indices, id: \.self) { index in
                let series = model.series[index]
                ForEach(series.values.indices, id: \.self) { point in
                    let x = PlottableValue.value("X", xValue(point))
                    let y = PlottableValue.value("Y", series.values[point])
                    let label = model.categories?[point] ?? model.x(at: point).formatted()
                    if series.kind == .bar {
                        let bar = BarMark(x: x, yStart: .value("Baseline", baseline), yEnd: y)
                            .foregroundStyle(colors[index])
                            .accessibilityLabel(label)
                            .accessibilityValue(series.values[point].formatted())
                        if groupBars { bar.position(by: .value("Series", index)) } else { bar }
                    } else {
                        LineMark(x: x, y: y, series: .value("Series", index))
                            .foregroundStyle(colors[index])
                            .symbol(.circle).symbolSize(16)
                            .accessibilityLabel(label)
                            .accessibilityValue(series.values[point].formatted())
                    }
                }
            }
        }
        .chartXAxisLabel(model.xTitle)
        .chartYAxisLabel(model.yTitle)
    }

}

private struct DiagramFlowView: View {
    let direction: String
    let nodes: [ConversationDiagramModel.Node]
    let edges: [ConversationDiagramModel.Edge]
    private let box = CGSize(width: 120, height: 56)
    private let margin: CGFloat = 25

    var body: some View {
        let horizontal = direction == "LR" || direction == "RL"
        let positions = positions(horizontal: horizontal)
        let width = (positions.values.map(\.x).max() ?? 0) + box.width / 2 + margin
        let height = (positions.values.map(\.y).max() ?? 0) + box.height / 2 + margin
        ScrollView(.horizontal) {
            ZStack(alignment: .topLeading) {
                Canvas { context, _ in
                    for edge in edges {
                        guard let from = positions[edge.from], let to = positions[edge.to] else { continue }
                        draw(edge, from: from, to: to, in: context)
                    }
                }
                ForEach(nodes, id: \.id) { node in
                    if let point = positions[node.id] {
                        Text(node.label)
                            .font(.caption.weight(.medium)).multilineTextAlignment(.center)
                            .minimumScaleFactor(0.7).lineLimit(3)
                            .padding(.horizontal, node.isDecision ? 20 : 6)
                            .frame(width: box.width, height: box.height)
                            .background {
                                let shape =
                                    node.isDecision
                                    ? AnyShape(DiagramDecision()) : AnyShape(RoundedRectangle(cornerRadius: 8))
                                shape.fill(Brand.relaySoft)
                                shape.stroke(Brand.relayText, lineWidth: 1)
                            }
                            .position(point)
                    }
                }
            }
            .frame(width: width, height: height)
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(
            edges.map { edge in
                let from = nodes.first { $0.id == edge.from }?.label ?? edge.from
                let to = nodes.first { $0.id == edge.to }?.label ?? edge.to
                return [from, edge.label, to].filter { !$0.isEmpty }.joined(separator: " → ")
            }.joined(separator: ", "))
    }

    private func positions(horizontal: Bool) -> [String: CGPoint] {
        var pending = nodes.map(\.id)
        var layers: [[String]] = []
        while !pending.isEmpty {
            let remaining = Set(pending)
            let roots = pending.filter { id in
                !edges.contains { $0.to == id && $0.from != id && remaining.contains($0.from) }
            }
            // A cyclic component still needs one starting point for this layout.
            let layer = roots.isEmpty ? [pending[0]] : roots
            layers.append(layer)
            pending.removeAll { layer.contains($0) }
        }
        if direction == "RL" || direction == "BT" { layers.reverse() }
        var result: [String: CGPoint] = [:]
        for (depth, layer) in layers.enumerated() {
            for (index, id) in layer.enumerated() {
                let x = CGFloat(horizontal ? depth : index) * (box.width + (horizontal ? 70 : 18))
                let y = CGFloat(horizontal ? index : depth) * (box.height + (horizontal ? 22 : 48))
                result[id] = CGPoint(x: margin + x + box.width / 2, y: margin + y + box.height / 2)
            }
        }
        return result
    }

    private func draw(
        _ edge: ConversationDiagramModel.Edge, from: CGPoint, to: CGPoint,
        in context: GraphicsContext
    ) {
        let dx = to.x - from.x
        let dy = to.y - from.y
        var path = Path()
        let tip: CGPoint
        let angle: CGFloat
        var label = CGPoint(x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 10)
        if from == to {
            let x = from.x + box.width / 2
            tip = CGPoint(x: x, y: from.y + 10)
            path.move(to: CGPoint(x: x, y: from.y - 10))
            path.addQuadCurve(to: tip, control: CGPoint(x: x + 40, y: from.y))
            angle = .pi * 0.84
            label = CGPoint(x: x + 8, y: from.y - 19)
        } else {
            let scale = min(
                dx == 0 ? .infinity : abs(box.width / (2 * dx)),
                dy == 0 ? .infinity : abs(box.height / (2 * dy)))
            path.move(to: CGPoint(x: from.x + dx * scale, y: from.y + dy * scale))
            tip = CGPoint(x: to.x - dx * scale, y: to.y - dy * scale)
            path.addLine(to: tip)
            angle = atan2(dy, dx)
        }
        for offset: CGFloat in [-0.48, 0.48] {
            path.move(to: tip)
            path.addLine(to: CGPoint(x: tip.x - 9 * cos(angle + offset), y: tip.y - 9 * sin(angle + offset)))
        }
        context.stroke(path, with: .color(Brand.muted), lineWidth: 1.5)
        if !edge.label.isEmpty { context.draw(Text(edge.label).font(.caption2), at: label) }
    }
}

private struct DiagramDecision: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: CGPoint(x: rect.midX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.midY))
            path.closeSubpath()
        }
    }
}
