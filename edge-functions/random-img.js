// 这个文件是为了在腾讯云 EdgeOne 上部署时，强制使用 EO 作为 KV 存储提供者

import app from "../app/index.js";

const withForcedEoProvider = (env = {}) => ({
	...env,
	KV_PROVIDER: "EO",
});

const handle = (request, env) => app.fetch(request, withForcedEoProvider(env));

// 腾讯云 EdgeOne 默认函数入口
export default async function onRequest(context) {
	const request = context?.request;
	const env = context?.env;

	if (!request) {
		return new Response("Bad Request: Missing request", { status: 400 });
	}

	return handle(request, env);
}
