import { handleRandomImg, handleRandomImgCount } from "./random-img.js";
import { jsonErrorResponse, jsonSuccessResponse } from "../commons/response.js";

// 是否启用图片数量统计入口：GET /random-img-count
const RANDOM_IMG_COUNT_ROUTE_ENABLED = true;

// 规范化路由路径：保留根路径，其余路径去掉尾部斜杠
const normalizePathname = (pathname) => {
	const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
	return normalizedPath.replace(/\/+$/, "") || "/";
};

// Worker 入口：根据路径分发至对应处理函数
export default {
	async fetch(request, env) {
		try {

			const url = new URL(request.url);
			const pathname = normalizePathname(url.pathname);
			if (pathname === "/") {
				return jsonErrorResponse({ status: 404, message: "No API route specified" });
			}
			if (pathname === "/healthcheck") {
				return jsonSuccessResponse({ message: "API on EdgeFunction is healthy" });
			}
			if (pathname === "/random-img") {
				return await handleRandomImg(request, env);
			}
			if (RANDOM_IMG_COUNT_ROUTE_ENABLED && pathname === "/random-img-count") {
				return await handleRandomImgCount(request, env);
			}

			return jsonErrorResponse({ status: 404, message: "API Not Found" });
		} catch (error) {
			console.error("Unhandled error in edge function:", error instanceof Error ? error.message : "unknown");
			return jsonErrorResponse({ status: 500, message: "Internal Server Error" });
		}
	},
};
