const KV_GET_MAX_ATTEMPTS = 5;
const KV_RETRY_BASE_DELAY_MS = 60;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const edgeKVClients = new Map();

const getEdgeKVClient = (namespace) => {
	if (!edgeKVClients.has(namespace)) {
		edgeKVClients.set(namespace, new EdgeKV({ namespace }));
	}
	return edgeKVClients.get(namespace);
};

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