import Foundation

enum ConversationDiagramModel {
    case pie(title: String, slices: [Slice])
    case xy(XYChart)
    case flow(direction: String, nodes: [Node], edges: [Edge])

    struct Slice: Equatable {
        let label: String
        let value: Double
    }
    struct Node: Equatable {
        let id: String
        let label: String
        let isDecision: Bool
    }
    struct Edge: Equatable {
        let from: String
        let to: String
        let label: String
    }

    init?(_ source: String) {
        guard source.utf8.count <= 32_768 else { return nil }
        let lines = source.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("%%") }
        guard let header = lines.first else { return nil }
        if ["xychart", "xychart-beta", "xychart vertical", "xychart-beta vertical"].contains(header) {
            guard let chart = XYChart(lines.dropFirst()) else { return nil }
            self = .xy(chart)
            return
        }
        if let fields = Self.match(#"^pie(?:\s+showData)?(?:\s+title\s+(.+))?$"#, in: header) {
            var slices: [Slice] = []
            var title = fields[1]
            for line in lines.dropFirst() {
                if title.isEmpty, line.hasPrefix("title ") {
                    title = String(line.dropFirst(6))
                    continue
                }
                guard let row = Self.match(#"^"([^"]+)"\s*:\s*(\d+(?:\.\d+)?)\s*;?$"#, in: line),
                    let value = Double(row[2]), value.isFinite
                else { return nil }
                slices.append(Slice(label: row[1], value: value))
            }
            let total = slices.reduce(0) { $0 + $1.value }
            guard slices.count <= 64, total.isFinite, total > 0 else { return nil }
            self = .pie(title: title, slices: slices)
            return
        }

        // Simple flowcharts can put several edges on one line separated by semicolons.
        let statements = lines.flatMap { $0.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) } }
        guard let first = statements.first,
            let fields = Self.match(#"^(?:graph|flowchart)\s+(LR|RL|TB|TD|BT)$"#, in: first)
        else { return nil }
        var nodes: [Node] = []
        var edges: [Edge] = []
        for statement in statements.dropFirst() {
            var rest = statement
            var previous: String?
            var edgeLabel = ""
            repeat {
                guard
                    let node = Self.match(
                        #"^([\p{L}\p{N}_-]+?)(?=--|[^\p{L}\p{N}_-]|$)(?:\[([^\[\]]+)\]|\{([^{}]+)\}|\(([^()]+)\))?"#,
                        in: rest)
                else { return nil }
                rest = String(rest.dropFirst(node[0].count)).trimmingCharacters(in: .whitespaces)
                let id = node[1]
                let label = node.dropFirst(2).first { !$0.isEmpty }
                let model = Node(
                    id: id, label: (label ?? id).trimmingCharacters(in: CharacterSet(charactersIn: "\"")),
                    isDecision: !node[3].isEmpty)
                if let index = nodes.firstIndex(where: { $0.id == id }) {
                    if label != nil { nodes[index] = model }
                } else {
                    nodes.append(model)
                }
                if let previous { edges.append(Edge(from: previous, to: id, label: edgeLabel)) }
                guard nodes.count <= 32, edges.count <= 64 else { return nil }
                if rest.isEmpty { break }
                guard let arrow = Self.match(#"^(?:-->\s*(?:\|([^|]+)\|)?|--\s+(.+?)\s+-->)\s*"#, in: rest) else {
                    return nil
                }
                edgeLabel = arrow[1].isEmpty ? arrow[2] : arrow[1]
                rest = String(rest.dropFirst(arrow[0].count))
                previous = id
            } while true
        }
        guard !nodes.isEmpty else { return nil }
        self = .flow(direction: fields[1], nodes: nodes, edges: edges)
    }

    private static func match(_ pattern: String, in line: String) -> [String]? {
        let regex = try! NSRegularExpression(pattern: pattern)  // Static grammar patterns.
        let fullRange = NSRange(line.startIndex..., in: line)
        guard let match = regex.firstMatch(in: line, range: fullRange) else { return nil }
        return (0..<match.numberOfRanges).map { i in
            Range(match.range(at: i), in: line).map { String(line[$0]) } ?? ""
        }
    }
}

extension ConversationDiagramModel {
    struct XYChart {
        enum Kind: String { case bar, line }

        struct Series {
            let kind: Kind
            let name: String?
            let values: [Double]
        }

        private(set) var title = ""
        private(set) var xTitle = ""
        private(set) var yTitle = ""
        private(set) var categories: [String]?
        private(set) var xRange: ClosedRange<Double>?
        private(set) var yRange: ClosedRange<Double>?
        private(set) var series: [Series] = []

        init?(_ lines: ArraySlice<String>) {
            var axes: Set<String> = []
            for line in lines {
                let fields = line.split(maxSplits: 1, whereSeparator: \.isWhitespace)
                guard fields.count == 2 else { return nil }
                let command = String(fields[0])
                let payload = fields[1].trimmingCharacters(in: .whitespaces)
                switch command {
                case "title":
                    guard title.isEmpty, let label = Self.label(payload) else { return nil }
                    title = label
                case "x-axis", "y-axis":
                    guard axes.insert(command).inserted, readAxis(command, payload) else { return nil }
                case "bar", "line":
                    guard series.count < 8, let kind = Kind(rawValue: command), let list = Self.list(payload)
                    else { return nil }
                    let values = list.items.compactMap(Self.number)
                    guard values.count == list.items.count else { return nil }
                    series.append(Series(kind: kind, name: list.title, values: values))
                default: return nil
                }
            }
            guard let count = series.first?.values.count, series.allSatisfy({ $0.values.count == count }),
                categories.map({ $0.count == count }) != false
            else { return nil }
            if let yRange, series.contains(where: { !$0.values.allSatisfy(yRange.contains) }) { return nil }
        }

        func x(at index: Int) -> Double {
            guard let range = xRange else { return Double(index + 1) }
            let count = series[0].values.count
            if count == 1 || index == 0 { return range.lowerBound }
            if index == count - 1 { return range.upperBound }
            return range.lowerBound + Double(index) / Double(count - 1) * (range.upperBound - range.lowerBound)
        }

        private mutating func readAxis(_ command: String, _ payload: String) -> Bool {
            if payload.contains("[") {
                guard command == "x-axis", let list = Self.list(payload) else { return false }
                let labels = list.items.compactMap(Self.label)
                guard labels.count == list.items.count, Set(labels).count == labels.count else { return false }
                categories = labels
                xTitle = list.title ?? ""
                return true
            }

            let bounds = payload.components(separatedBy: "-->")
            guard bounds.count <= 2 else { return false }
            var label: String?
            var range: ClosedRange<Double>?
            if bounds.count == 2 {
                let left = bounds[0].trimmingCharacters(in: .whitespaces)
                let first = left.lastIndex(where: \.isWhitespace).map { left.index(after: $0) } ?? left.startIndex
                let name = left[..<first].trimmingCharacters(in: .whitespaces)
                label = Self.label(name)
                guard name.isEmpty || label != nil, let min = Self.number(String(left[first...])),
                    let max = Self.number(bounds[1].trimmingCharacters(in: .whitespaces)), min < max
                else { return false }
                range = min...max
            } else {
                label = Self.label(payload)
                guard label != nil else { return false }
            }
            if command == "x-axis" {
                xTitle = label ?? ""
                xRange = range
            } else {
                yTitle = label ?? ""
                yRange = range
            }
            return true
        }

        private static func number(_ value: String) -> Double? {
            guard let number = Double(value), number.isFinite, abs(number) <= 1e15 else { return nil }
            return number
        }

        private static func label(_ source: String) -> String? {
            var value = source[...]
            if value.first == "\"", value.last == "\"", value.count >= 2 {
                value = value.dropFirst().dropLast()
            } else if value.contains(where: \.isWhitespace) {
                return nil
            }
            guard !value.isEmpty, value.count <= 128, !value.contains(where: { "\"[]".contains($0) })
            else { return nil }
            return String(value)
        }

        private static func list(_ payload: String) -> (title: String?, items: [String])? {
            guard let opening = payload.firstIndex(of: "["), payload.last == "]" else { return nil }
            let name = payload[..<opening].trimmingCharacters(in: .whitespaces)
            let title = label(name)
            guard name.isEmpty || title != nil else { return nil }
            let body = payload[payload.index(after: opening)..<payload.index(before: payload.endIndex)]
            let items = body.split(separator: ",", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces) }
            guard (1...64).contains(items.count), !items.contains("") else { return nil }
            return (title, items)
        }
    }
}
