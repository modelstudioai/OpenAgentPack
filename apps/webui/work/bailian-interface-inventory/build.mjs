import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outputDir = new URL("../../outputs/bailian-interface-inventory", import.meta.url).pathname;
const outputPath = `${outputDir}/bailian-agent-workflow-interface-inventory.xlsx`;

const sheets = [
	{
		name: "管控面接口",
		columns: ["模块", "接口类型", "典型接口", "说明", "核心入参", "核心出参", "优先级"],
		rows: [
			[
				"Workspace",
				"当前 Workspace 查询",
				"GetCurrentWorkspace",
				"查询当前用户默认 workspace、workspaceId、权限范围",
				"AccessToken / AccountContext",
				"workspaceId, workspaceName, role, permissions",
				"P0",
			],
			[
				"Workspace",
				"Workspace 列表",
				"ListWorkspaces",
				"查询当前账号可访问的 workspace",
				"AccessToken, pagination",
				"workspaces[]",
				"P1",
			],
			[
				"应用发现",
				"应用清单查询",
				"ListAppsByWorkspace",
				"按 workspace 查询智能体/工作流列表",
				"workspaceId, appType, status, tag, pagination",
				"apps[]{id,name,type,semantic,status}",
				"P0",
			],
			[
				"应用发现",
				"应用模糊搜索",
				"SearchAppsByName",
				"按名称、关键词搜索应用",
				"workspaceId, keyword, appType, status",
				"apps[]{id,name,type,semantic,score}",
				"P0",
			],
			[
				"应用发现",
				"应用语义搜索",
				"SearchAppsByIntent",
				"输入用户任务描述，返回匹配的智能体/工作流",
				"workspaceId, intent, appType, topK",
				"apps[]{id,name,type,semantic,matchReason,score}",
				"P0",
			],
			[
				"应用发现",
				"应用分类查询",
				"ListAppCategories",
				"查询业务域、标签、类型分类",
				"workspaceId",
				"categories[], tags[], domains[]",
				"P1",
			],
			[
				"应用详情",
				"应用详情查询",
				"GetAppDetail",
				"查询名称、类型、描述、语义、状态、版本",
				"workspaceId, appId",
				"appDetail{id,name,type,description,semantic,status,version}",
				"P0",
			],
			[
				"应用详情",
				"应用能力描述",
				"GetAppCapability",
				"返回适用场景、不适用场景、典型意图、能力边界",
				"workspaceId, appId",
				"capability{scenarios, antiScenarios, intents, boundaries}",
				"P0",
			],
			[
				"应用详情",
				"应用调用说明",
				"GetAppInvocationGuide",
				"返回调用方式、同步/异步/流式支持情况",
				"workspaceId, appId",
				"guide{callModes, streamSupported, asyncSupported, sessionSupported}",
				"P0",
			],
			[
				"Schema",
				"入参 Schema 查询",
				"GetAppInputSchema",
				"返回字段名、类型、必填、默认值、示例、约束",
				"workspaceId, appId, version",
				"jsonSchema, examples, constraints",
				"P0",
			],
			[
				"Schema",
				"出参 Schema 查询",
				"GetAppOutputSchema",
				"返回输出结构、字段含义、示例、错误结构",
				"workspaceId, appId, version",
				"outputSchema, eventSchema, errorSchema",
				"P0",
			],
			[
				"Schema",
				"调用示例查询",
				"ListAppInvocationExamples",
				"返回最小调用、完整调用、文件输入、多轮调用示例",
				"workspaceId, appId",
				"examples[]{title,input,output,mode}",
				"P0",
			],
			[
				"Schema",
				"Tool Manifest 导出",
				"ExportAppToolManifest",
				"导出 OpenAPI / MCP / function calling 工具定义",
				"workspaceId, appId, format",
				"manifest",
				"P0",
			],
			[
				"权限",
				"可调用性检查",
				"CheckAppCallable",
				"判断当前用户是否有权限调用某应用",
				"workspaceId, appId, caller",
				"callable, missingPermissions, reason",
				"P0",
			],
			[
				"权限",
				"权限详情查询",
				"GetAppPermission",
				"查询调用、编辑、发布、查看日志等权限",
				"workspaceId, appId, caller",
				"permissions{}",
				"P1",
			],
			[
				"状态",
				"应用状态查询",
				"GetAppStatus",
				"查询草稿、已发布、下线、异常等状态",
				"workspaceId, appId",
				"status, publishedVersion, draftVersion",
				"P0",
			],
			[
				"版本",
				"版本列表查询",
				"ListAppVersions",
				"查询历史版本、当前生产版本、草稿版本",
				"workspaceId, appId, pagination",
				"versions[]",
				"P1",
			],
			[
				"版本",
				"版本详情查询",
				"GetAppVersionDetail",
				"查询某版本配置、发布时间、变更说明",
				"workspaceId, appId, versionId",
				"versionDetail",
				"P1",
			],
			[
				"发布",
				"发布状态查询",
				"GetPublishStatus",
				"查询 dev/test/prod 环境发布情况",
				"workspaceId, appId, env",
				"publishStatus, endpoint, rollout",
				"P1",
			],
			[
				"发布",
				"应用发布",
				"PublishApp",
				"将草稿发布为可调用版本",
				"workspaceId, appId, versionDesc",
				"versionId, publishStatus",
				"P2",
			],
			[
				"发布",
				"应用回滚",
				"RollbackAppVersion",
				"回滚到历史版本",
				"workspaceId, appId, targetVersionId",
				"versionId, rollbackStatus",
				"P2",
			],
			[
				"依赖",
				"应用依赖查询",
				"ListAppDependencies",
				"查询绑定模型、知识库、插件、MCP 工具、变量",
				"workspaceId, appId, version",
				"models[], knowledgeBases[], tools[], variables[]",
				"P0",
			],
			[
				"依赖",
				"模型配置查询",
				"GetAppModelConfig",
				"查询模型、temperature、top_p、上下文窗口等",
				"workspaceId, appId, version",
				"modelConfig",
				"P1",
			],
			[
				"依赖",
				"知识库绑定查询",
				"ListAppKnowledgeBases",
				"查询应用绑定的知识库、索引状态",
				"workspaceId, appId",
				"knowledgeBases[]{id,name,indexStatus}",
				"P1",
			],
			[
				"依赖",
				"插件/工具查询",
				"ListAppTools",
				"查询智能体或工作流可调用工具",
				"workspaceId, appId",
				"tools[]{id,name,schema,authType}",
				"P1",
			],
			[
				"限制",
				"调用限制查询",
				"GetAppLimits",
				"查询 QPS、并发、超时、文件大小、token 限制",
				"workspaceId, appId",
				"limits{qps,concurrency,timeout,maxTokens,maxFileSize}",
				"P0",
			],
			[
				"成本",
				"成本预估查询",
				"EstimateInvocationCost",
				"根据输入规模估算 token、费用、耗时",
				"workspaceId, appId, inputPreview",
				"estimatedTokens, estimatedCost, estimatedLatency",
				"P2",
			],
		],
	},
	{
		name: "应用面接口",
		columns: ["模块", "接口类型", "典型接口", "说明", "核心入参", "核心出参", "优先级"],
		rows: [
			[
				"智能体调用",
				"同步调用",
				"CallAgent",
				"一次请求返回完整结果",
				"workspaceId, agentId, prompt, bizParams",
				"message, usage, traceId, sessionId",
				"P0",
			],
			[
				"智能体调用",
				"流式调用",
				"StreamCallAgent",
				"SSE/stream 返回模型输出、工具调用事件",
				"workspaceId, agentId, prompt, stream=true",
				"events[]{delta,toolCall,done,error}",
				"P0",
			],
			[
				"智能体调用",
				"多轮调用",
				"CallAgentWithSession",
				"带 sessionId 的上下文调用",
				"workspaceId, agentId, sessionId, prompt",
				"message, sessionId, usage, traceId",
				"P0",
			],
			[
				"工作流调用",
				"同步运行",
				"RunWorkflowSync",
				"适合短耗时工作流",
				"workspaceId, workflowId, parameters",
				"outputs, usage, traceId",
				"P1",
			],
			[
				"工作流调用",
				"异步提交",
				"SubmitWorkflowRun",
				"提交后返回 runId",
				"workspaceId, workflowId, parameters, clientToken",
				"runId, status",
				"P0",
			],
			[
				"工作流调用",
				"获取运行结果",
				"GetWorkflowRunResult",
				"根据 runId 获取最终结果",
				"workspaceId, runId",
				"status, outputs, artifacts, usage",
				"P0",
			],
			[
				"任务控制",
				"运行状态查询",
				"GetRunStatus",
				"查询 pending/running/succeeded/failed/canceled",
				"workspaceId, runId",
				"status, currentNode, progress, error",
				"P0",
			],
			[
				"任务控制",
				"取消运行",
				"CancelRun",
				"CLI Ctrl+C 后释放后端任务",
				"workspaceId, runId",
				"canceled, status",
				"P0",
			],
			[
				"任务控制",
				"重试运行",
				"RetryRun",
				"对失败任务基于原参数重试",
				"workspaceId, runId, retryPolicy",
				"newRunId, status",
				"P1",
			],
			[
				"任务控制",
				"运行恢复",
				"ResumeRun",
				"从中断点恢复长任务或人工节点",
				"workspaceId, runId, resumeToken",
				"runId, status",
				"P1",
			],
			[
				"参数",
				"参数校验",
				"ValidateAppInvocation",
				"调用前校验入参、权限、文件、依赖",
				"workspaceId, appId, parameters",
				"valid, missingParams, errors, suggestions",
				"P0",
			],
			[
				"参数",
				"参数补全建议",
				"SuggestInvocationParams",
				"根据用户意图和 schema 生成建议参数",
				"workspaceId, appId, userIntent",
				"suggestedParams, confidence, missingInfo",
				"P1",
			],
			[
				"会话",
				"创建会话",
				"CreateSession",
				"为智能体创建独立上下文",
				"workspaceId, agentId, sessionName",
				"sessionId, createdAt",
				"P0",
			],
			["会话", "查询会话", "GetSession", "查询 session 元信息", "workspaceId, sessionId", "sessionInfo", "P1"],
			[
				"会话",
				"历史消息查询",
				"ListSessionMessages",
				"获取多轮对话历史",
				"workspaceId, sessionId, limit, nextToken",
				"messages[], nextToken",
				"P1",
			],
			["会话", "清空会话", "ClearSession", "重置上下文", "workspaceId, sessionId", "success", "P1"],
			[
				"文件",
				"文件上传",
				"UploadFile",
				"本地文件转临时可访问资源",
				"workspaceId, file, purpose",
				"fileId, url, expiresAt, metadata",
				"P0",
			],
			[
				"文件",
				"文件下载",
				"DownloadArtifact",
				"下载工作流或智能体生成产物",
				"workspaceId, artifactId",
				"downloadUrl, fileName, expiresAt",
				"P0",
			],
			[
				"文件",
				"文件能力查询",
				"GetSupportedFileTypes",
				"查询支持的文件类型、大小、字段映射",
				"workspaceId, appId",
				"fileTypes[], maxSize, fields[]",
				"P0",
			],
			[
				"输出",
				"结构化结果获取",
				"GetStructuredOutput",
				"获取 JSON/table/form 等机器可读结果",
				"workspaceId, runId, format",
				"structuredOutput",
				"P0",
			],
			[
				"输出",
				"流式事件获取",
				"StreamRunEvents",
				"返回节点开始、节点完成、工具调用、错误等事件",
				"workspaceId, runId",
				"events[]",
				"P0",
			],
			[
				"输出",
				"引用来源获取",
				"GetCitations",
				"查询知识库引用、文档片段、来源链接",
				"workspaceId, runId",
				"citations[]",
				"P1",
			],
			[
				"人工介入",
				"等待人工输入查询",
				"GetPendingHumanInput",
				"查询工作流是否卡在审批/补参节点",
				"workspaceId, runId",
				"pendingInputs[]",
				"P1",
			],
			[
				"人工介入",
				"提交人工输入",
				"SubmitHumanInput",
				"给人工节点提交选择、确认、补充参数",
				"workspaceId, runId, nodeId, input",
				"accepted, status",
				"P1",
			],
		],
	},
	{
		name: "观测调试接口",
		columns: ["模块", "接口类型", "典型接口", "说明", "核心入参", "核心出参", "优先级"],
		rows: [
			[
				"Trace",
				"运行 Trace 查询",
				"GetRunTrace",
				"查询完整执行链路",
				"workspaceId, runId",
				"trace{steps,timeline,usage,error}",
				"P0",
			],
			[
				"Trace",
				"智能体思考/工具轨迹",
				"GetAgentTrace",
				"查询模型调用、工具调用、知识库检索过程",
				"workspaceId, agentId, runId",
				"steps[]{type,input,output,latency}",
				"P0",
			],
			[
				"节点日志",
				"工作流节点日志",
				"ListWorkflowNodeLogs",
				"查询每个节点输入、输出、耗时、错误",
				"workspaceId, workflowId, runId, nodeId?",
				"nodeExecutions[]",
				"P0",
			],
			[
				"节点日志",
				"单节点详情",
				"GetNodeExecutionDetail",
				"查询指定 nodeId 的执行详情",
				"workspaceId, runId, nodeId",
				"nodeExecutionDetail",
				"P1",
			],
			[
				"日志",
				"调用日志查询",
				"ListInvocationLogs",
				"按 appId、runId、时间、状态查询调用记录",
				"workspaceId, appId, status, timeRange, nextToken",
				"logs[], nextToken",
				"P1",
			],
			[
				"错误",
				"错误详情查询",
				"GetRunErrorDetail",
				"返回错误码、错误位置、修复建议",
				"workspaceId, runId",
				"errorCode, message, location, suggestion, retryable",
				"P0",
			],
			[
				"指标",
				"用量查询",
				"GetUsageMetrics",
				"token、调用次数、耗时、费用",
				"workspaceId, appId, timeRange",
				"usageMetrics",
				"P1",
			],
			[
				"指标",
				"性能查询",
				"GetLatencyMetrics",
				"平均耗时、P95、P99、节点耗时",
				"workspaceId, appId, timeRange",
				"latencyMetrics",
				"P2",
			],
			[
				"指标",
				"成功率查询",
				"GetSuccessRateMetrics",
				"成功率、失败率、取消率",
				"workspaceId, appId, timeRange",
				"successRateMetrics",
				"P2",
			],
			[
				"审计",
				"审计日志查询",
				"ListAuditLogs",
				"查询谁调用、谁修改、谁发布",
				"workspaceId, resourceId, action, timeRange",
				"auditLogs[]",
				"P2",
			],
		],
	},
	{
		name: "CLI Agent适配接口",
		columns: ["模块", "接口类型", "典型接口", "说明", "核心入参", "核心出参", "优先级"],
		rows: [
			[
				"工具发现",
				"可用工具清单",
				"ListCallableTools",
				"返回当前 CLI Agent 可注册的百炼应用工具",
				"workspaceId, filters",
				"tools[]{id,name,description,schema}",
				"P0",
			],
			[
				"工具发现",
				"工具详情",
				"GetToolDefinition",
				"返回工具名、描述、schema、示例",
				"workspaceId, toolId",
				"toolDefinition",
				"P0",
			],
			[
				"工具注册",
				"MCP 工具定义导出",
				"ExportMcpToolDefinition",
				"把智能体/工作流导出成 MCP tool",
				"workspaceId, appId",
				"mcpToolDefinition",
				"P0",
			],
			[
				"工具注册",
				"Function Calling 导出",
				"ExportFunctionDefinition",
				"导出 OpenAI-compatible function schema",
				"workspaceId, appId",
				"functionDefinition",
				"P0",
			],
			[
				"输出控制",
				"输出格式声明",
				"GetSupportedOutputFormats",
				"查询支持 text/json/markdown/table/file",
				"workspaceId, appId",
				"formats[]",
				"P0",
			],
			[
				"CLI 运行",
				"Dry Run",
				"DryRunAppInvocation",
				"不真实执行，只校验参数和调用计划",
				"workspaceId, appId, parameters",
				"valid, plan, warnings, suggestions",
				"P0",
			],
			[
				"CLI 运行",
				"幂等调用",
				"InvokeWithClientToken",
				"用 clientToken 防止 CLI 重试重复执行",
				"workspaceId, appId, parameters, clientToken",
				"runId, status, deduplicated",
				"P0",
			],
			[
				"CLI 运行",
				"断点恢复",
				"GetResumeToken / ResumeByToken",
				"长任务中断后恢复",
				"workspaceId, runId / resumeToken",
				"resumeToken / runStatus",
				"P1",
			],
			[
				"错误修复",
				"错误修复建议",
				"GetErrorSuggestion",
				"返回可给 Agent 使用的修复建议",
				"workspaceId, errorCode, context",
				"suggestion, patchableParams, retryable",
				"P0",
			],
			[
				"任务推荐",
				"应用选择建议",
				"RecommendAppForTask",
				"根据用户任务推荐最合适应用",
				"workspaceId, taskDescription, topK",
				"recommendations[]{appId,reason,confidence}",
				"P0",
			],
		],
	},
	{
		name: "P0最小闭环",
		columns: ["阶段", "必备接口", "目标"],
		rows: [
			["发现应用", "ListAppsByWorkspace; SearchAppsByName; SearchAppsByIntent", "让 CLI Agent 找到可用的智能体/工作流"],
			[
				"理解应用",
				"GetAppDetail; GetAppCapability; GetAppInputSchema; GetAppOutputSchema",
				"让 Agent 理解应用语义、边界、参数和输出",
			],
			[
				"注册工具",
				"ExportAppToolManifest; ExportMcpToolDefinition; ExportFunctionDefinition",
				"让百炼应用可被 CLI Agent 注册为工具",
			],
			[
				"调用前检查",
				"CheckAppCallable; GetAppLimits; ValidateAppInvocation; DryRunAppInvocation",
				"提前发现权限、参数、限制和依赖问题",
			],
			["实际调用", "CallAgent; StreamCallAgent; SubmitWorkflowRun", "覆盖智能体和工作流的核心调用路径"],
			["运行控制", "GetRunStatus; CancelRun; GetWorkflowRunResult", "支持异步运行、取消和结果获取"],
			[
				"调试修复",
				"GetRunTrace; ListWorkflowNodeLogs; GetRunErrorDetail; GetErrorSuggestion",
				"让 Agent 能定位失败原因并自我修正",
			],
		],
	},
];

function colLetter(index) {
	let n = index + 1;
	let s = "";
	while (n > 0) {
		const m = (n - 1) % 26;
		s = String.fromCharCode(65 + m) + s;
		n = Math.floor((n - m) / 26);
	}
	return s;
}

function setWidths(sheet) {
	const widths = [110, 150, 210, 360, 340, 340, 80];
	widths.forEach((width, index) => {
		const letter = colLetter(index);
		sheet.getRange(`${letter}:${letter}`).format.columnWidthPx = width;
	});
}

function styleSheet(sheet, columnCount, rowCount) {
	const lastCol = colLetter(columnCount - 1);
	const titleRange = sheet.getRange(`A1:${lastCol}1`);
	titleRange.format.fill.color = "#EAF2FF";
	titleRange.format.font.bold = true;
	titleRange.format.font.color = "#17324D";

	const dataRange = sheet.getRange(`A1:${lastCol}${rowCount}`);
	dataRange.format.font.name = "Aptos";
	dataRange.format.font.size = 10;

	for (let row = 2; row <= rowCount; row += 1) {
		if (row % 2 === 0) {
			sheet.getRange(`A${row}:${lastCol}${row}`).format.fill.color = "#F8FAFC";
		}
	}

	setWidths(sheet);
}

async function main() {
	const workbook = Workbook.create();

	for (const spec of sheets) {
		const colCount = spec.columns.length;
		const sheet = workbook.worksheets.add(spec.name);
		const matrix = [spec.columns, ...spec.rows];
		const lastCol = colLetter(colCount - 1);
		sheet.getRange(`A1:${lastCol}${matrix.length}`).values = matrix;
		styleSheet(sheet, colCount, matrix.length);
	}

	await fs.mkdir(outputDir, { recursive: true });

	// Per-sheet inspect/render are debug previews (they don't touch the saved xlsx), so run them
	// together instead of one sheet after another.
	await Promise.all(
		sheets.map((spec) => {
			const colCount = spec.columns.length;
			const lastCol = colLetter(colCount - 1);
			return Promise.all([
				workbook.inspect({
					kind: "table",
					range: `${spec.name}!A1:${lastCol}${Math.min(spec.rows.length + 1, 12)}`,
					include: "values",
					tableMaxRows: 12,
					tableMaxCols: colCount,
					summary: `inspect ${spec.name}`,
				}),
				workbook.render({
					sheetName: spec.name,
					range: `A1:${lastCol}${Math.min(spec.rows.length + 1, 18)}`,
					scale: 1,
				}),
			]);
		}),
	);

	// The final error scan is independent of serialization, so run it alongside the export; save
	// still waits on the exported output.
	const [, output] = await Promise.all([
		workbook.inspect({
			kind: "match",
			searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
			options: { useRegex: true, maxResults: 300 },
			summary: "final formula error scan",
		}),
		SpreadsheetFile.exportXlsx(workbook),
	]);
	await output.save(outputPath);
	console.log(outputPath);
}

main().catch((error) => {
	console.error(`${error.name}: ${error.message}`);
	console.error(
		String(error.stack || "")
			.split("\n")
			.slice(0, 10)
			.join("\n"),
	);
	process.exit(1);
});
