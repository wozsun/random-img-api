import app from "../../app/index.js";

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
