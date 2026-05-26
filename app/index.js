import { handleRandomImg } from "./random-img.js";
import { jsonErrorResponse } from "../commons/response.js";


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
			if (pathname === "/random-img") {
				return await handleRandomImg(request, env);
			}

			return jsonErrorResponse({ status: 404, message: "API Not Found" });
		} catch (error) {
			console.error("Unhandled error in edge function:", error instanceof Error ? error.message : "unknown");
			return jsonErrorResponse({ status: 500, message: "Internal Server Error" });
		}
	},
};
