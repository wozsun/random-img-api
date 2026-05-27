import { handleRandomImg, handleRandomImgCount } from "./random-img.js";
import { jsonErrorResponse, jsonSuccessResponse } from "../commons/response.js";

// 是否启用图片数量统计入口：GET /random-img-count
const RANDOM_IMG_COUNT_ROUTE_ENABLED = true;
// 允许携带实际 query 参数的普通路由；不在列表中的普通路由默认禁止
const QUERY_ALLOWED_ROUTES = Object.freeze(["/random-img"]);
const queryAllowedRouteSet = new Set(QUERY_ALLOWED_ROUTES);

// 规范化路由路径：保留根路径，其余路径压缩前导斜杠并去掉尾部斜杠
const normalizePathname = (pathname) => {
    const normalizedPath = `/${pathname.replace(/^\/+/, "")}`;
    return normalizedPath.replace(/\/+$/, "") || "/";
};

const ROUTE_HANDLERS = (() => {
    const routeHandlers = new Map([
        ["/", () => jsonErrorResponse({ status: 404, message: "No API route specified" })],
        ["/healthcheck", () => jsonSuccessResponse({ message: "API on EdgeFunction is healthy" })],
        ["/random-img", handleRandomImg],
    ]);

    if (RANDOM_IMG_COUNT_ROUTE_ENABLED) {
        routeHandlers.set("/random-img-count", handleRandomImgCount);
    }

    return routeHandlers;
})();

// 默认禁止实际 query 参数；确实需要 query 的普通路由需加入 QUERY_ALLOWED_ROUTES
const rejectQuery = (query) => {
    if (query.size > 0) {
        return jsonErrorResponse({
            status: 403,
            message: "Forbidden: Query parameters are not allowed",
        });
    }

    return null;
};

// Worker 入口：根据路径分发至对应处理函数
export default {
    async fetch(request, env) {
        try {
            const url = new URL(request.url);
            const pathname = normalizePathname(url.pathname);

            const routeHandler = ROUTE_HANDLERS.get(pathname);
            if (routeHandler) {
                if (!queryAllowedRouteSet.has(pathname)) {
                    const queryResponse = rejectQuery(url.searchParams);
                    if (queryResponse) {
                        return queryResponse;
                    }
                }

                return await routeHandler(request, env);
            }

            return jsonErrorResponse({ status: 404, message: "API Not Found" });
        } catch (error) {
            console.error("Unhandled error in edge function:", error instanceof Error ? error.message : "unknown");
            return jsonErrorResponse({ status: 500, message: "Internal Server Error" });
        }
    },
};
