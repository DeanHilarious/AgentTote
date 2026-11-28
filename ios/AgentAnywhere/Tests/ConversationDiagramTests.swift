#if AA_CONVERSATION_DIAGRAM_TESTS
import Foundation

@main enum ConversationDiagramTests {
    static func main() {
        guard
            case .flow(let direction, let nodes, let edges) = ConversationDiagramModel(
                """
                graph LR; A[输入] --> D{判断}; D -->|通过| E[完成]; D -- 重试 --> A
                """)
        else { fatalError("Expected labelled flowchart") }
        precondition(direction == "LR" && nodes.map(\.label) == ["输入", "判断", "完成"])
        precondition(nodes[1].isDecision && edges.map(\.label) == ["", "通过", "重试"])
        guard
            case .pie(let title, let values) = ConversationDiagramModel(
                """
                pie showData title 工作量
                "研发" : 6
                "验收" : 4
                """)
        else { fatalError("Expected pie chart") }
        precondition(title == "工作量" && values.map(\.value) == [6, 4])
        precondition(ConversationDiagramModel("graph LR\nA -->") == nil)
        precondition(ConversationDiagramModel("gantt\nfoo") == nil)
        precondition(ConversationDiagramModel("pie\n\"A\" : 0") == nil)
        guard
            case .xy(let mixed) = ConversationDiagramModel(
                """
                xychart-beta
                title "半年销售额"
                x-axis "月份" [一月, "Feb 2026", 三月]
                y-axis "收入（万元）" -2 --> 10
                bar "销售" [3.5, -1, 7]
                line "目标" [2, .5, 8]
                """)
        else { fatalError("Expected mixed bar and line chart") }
        precondition(mixed.categories == ["一月", "Feb 2026", "三月"] && mixed.yRange == -2...10)
        precondition(mixed.title == "半年销售额" && mixed.xTitle == "月份" && mixed.yTitle == "收入（万元）")
        precondition(
            mixed.series[0].name == "销售" && mixed.series[0].kind == .bar && mixed.series[0].values == [3.5, -1, 7])
        precondition(mixed.series[1].kind == .line && mixed.series[1].values == [2, 0.5, 8])
        guard
            case .xy(let numeric) = ConversationDiagramModel("xychart vertical\nx-axis time 100 --> 150\nline [1,2,3]")
        else { fatalError("Expected numeric x-axis") }
        precondition([0, 1, 2].map(numeric.x(at:)) == [100, 125, 150])
        precondition(ConversationDiagramModel("xychart\nx-axis [A,B]\nbar [1]") == nil)
        precondition(ConversationDiagramModel("xychart\nbar [1,2]\nline [3]") == nil)
        precondition(ConversationDiagramModel("xychart\ny-axis 5 --> 1\nline [2]") == nil)
        precondition(ConversationDiagramModel("xychart\ny-axis 0 --> 5\nbar [6]") == nil)
        precondition(ConversationDiagramModel("xychart\nbar [nan]") == nil)
        precondition(ConversationDiagramModel("xychart horizontal\nbar [1]") == nil)
        print(
            "Diagram parser passed flow, pie, numeric and categorical XY, bar/line series and unsupported syntax cases")
    }
}
#endif
