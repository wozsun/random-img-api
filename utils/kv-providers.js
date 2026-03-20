const edgeKVClients = new Map();

const getEsaKvClient = ({ namespace }) => {
	if (!edgeKVClients.has(namespace)) {
		edgeKVClients.set(namespace, new EdgeKV({ namespace }));
	}
	return edgeKVClients.get(namespace);
};

const getCfKvClient = ({ env, namespace }) => env?.[namespace] ?? null;

const getEoKvClient = ({ namespace }) => globalThis?.[namespace] ?? null;

const KV_PROVIDER_CLIENT_RESOLVERS = {
	ESA: getEsaKvClient,
	CF: getCfKvClient,
	EO: getEoKvClient,
};

// 从环境变量读取 KV 提供商标识，默认为 ESA
export const getKvProvider = (env) => env?.KV_PROVIDER || "ESA";

// 根据 provider 获取对应平台的 KV 客户端
export const getKvClientByProvider = ({ provider, env, namespace }) => {
	const resolver = KV_PROVIDER_CLIENT_RESOLVERS[provider];
	if (!resolver) {
		return null;
	}
	return resolver({ env, namespace });
};

// 根据环境与 namespace 获取对应平台的 KV 客户端
export const getKvClient = ({ env, namespace }) => {
	const provider = getKvProvider(env);
	return getKvClientByProvider({ provider, env, namespace });
};