const KV_GET_MAX_ATTEMPTS = 5;
const KV_RETRY_BASE_DELAY_MS = 60;

// 异步等待指定毫秒数
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 从 EdgeOne KV 读取指定键的值，失败时按退避策略自动重试
export const fetchFromKv = async ({ namespace, key, type }) => {
	const kvClient = globalThis?.[namespace] ?? null;
	if (!kvClient || typeof kvClient.get !== "function") {
		return null;
	}

	for (let attempt = 1; attempt <= KV_GET_MAX_ATTEMPTS; attempt++) {
		try {
			// EdgeOne 文档支持 get(key, "json") 与 get(key, { type: "json" }) 两种形态
			const value = await kvClient.get(key, { type });
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
