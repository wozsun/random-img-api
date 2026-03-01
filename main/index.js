import { handleRandomImg, handleRandomImgCount } from "../random-img/function.js";
import { jsonErrorResponse, jsonSuccessResponse } from "./response.js";

// ===========================
// 全局错误定义
// ===========================
const GLOBAL_ERRORS = {
	NOT_FOUND: { status: 404, message: "API Not Found" },
	INTERNAL_ERROR: { status: 500, message: "Internal Server Error" },
};

// ===========================
// 路由配置
// ===========================
const routes = {
	// 根路径统一按未找到处理，避免暴露额外信息。
	"/": async () => jsonErrorResponse(GLOBAL_ERRORS.NOT_FOUND),
	// 基础示例接口，用于快速验证 JSON 成功响应链路。
	"/hello": async () => jsonSuccessResponse({ message: "Hello, World!" }),
	// 健康检查接口，用于监控系统判断边缘函数存活状态。
	"/healthcheck": async () => jsonSuccessResponse({ message: "API on EdgeFunction is healthy" }),
	// 随机图片业务入口，交由 random-img 模块统一处理。
	"/random-img": handleRandomImg,
	"/random-img-count": handleRandomImgCount,
};

// ===========================
// 边缘函数入口
// ===========================
export default {
	// 边缘函数主入口：按 pathname 分发路由并兜底处理未捕获异常。
	async fetch(request) {
		try {
			const { pathname } = new URL(request.url);
			const handler = routes[pathname];

			if (handler) {
				return await handler(request);
			}

			return jsonErrorResponse(GLOBAL_ERRORS.NOT_FOUND);
		} catch (error) {
			// 捕获未预期的错误，避免函数崩溃
			console.error("Unhandled error in edge function:", error);
			return jsonErrorResponse(GLOBAL_ERRORS.INTERNAL_ERROR);
		}
	},
};
