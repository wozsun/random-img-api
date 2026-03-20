// ESA
const edgeKVClients = new Map();
const getEsaKvClient = ({ namespace }) => {
	if (!edgeKVClients.has(namespace)) {
		edgeKVClients.set(namespace, new EdgeKV({ namespace }));
	}
	return edgeKVClients.get(namespace);
};

// Cloudflare
const getCfKvClient = ({ env, namespace }) => env?.[namespace] ?? null;

// EdgeOne
const getEoKvClient = ({ namespace }) => globalThis?.[namespace] ?? null;

// Config
const KV_PROVIDER_CLIENT_RESOLVERS = {
	ESA: getEsaKvClient,
	CF: getCfKvClient,
	EO: getEoKvClient,
};

// 根据环境与 namespace 获取对应平台的 KV 客户端
export const getKvClient = ({ env, namespace }) => {
	const provider = env?.KV_PROVIDER || "ESA";
	const resolver = KV_PROVIDER_CLIENT_RESOLVERS[provider];
	if (!resolver) {
		return null;
	}
	return resolver({ env, namespace });
};