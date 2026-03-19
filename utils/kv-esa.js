const KV_GET_MAX_ATTEMPTS = 5;
const KV_RETRY_BASE_DELAY_MS = 60;

// 异步等待指定毫秒数
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const edgeKVClients = new Map();

// 获取或创建指定 namespace 的 EdgeKV 客户端单例
const getEdgeKVClient = (namespace) => {
	if (!edgeKVClients.has(namespace)) {
		edgeKVClients.set(namespace, new EdgeKV({ namespace }));
	}
	return edgeKVClients.get(namespace);
};

// 从 EdgeKV 读取指定键的值，失败时按退避策略自动重试
export const fetchFromKv = async ({ namespace, key, type }) => {
	for (let attempt = 1; attempt <= KV_GET_MAX_ATTEMPTS; attempt++) {
		try {
			const value = await getEdgeKVClient(namespace).get(key, { type });
			return value ?? null;
		} catch {
			if (attempt >= KV_GET_MAX_ATTEMPTS) {
				return null;
			}
			await sleep(KV_RETRY_BASE_DELAY_MS * attempt);
		}
	}

	return null;
};