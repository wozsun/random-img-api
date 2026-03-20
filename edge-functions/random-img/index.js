import app from "../../index.js";

const withForcedEoProvider = (env = {}) => ({
	...env,
	KV_PROVIDER: "EO",
});

const handle = (request, env, ctx) => app.fetch(request, withForcedEoProvider(env), ctx);

// 腾讯云 EdgeOne 默认函数入口
export default async function onRequest(context) {
	const request = context?.request;
	const env = context?.env;
	const ctx = context?.ctx;

	if (!request) {
		return new Response("Bad Request: Missing request", { status: 400 });
	}

	return handle(request, env, ctx);
}
