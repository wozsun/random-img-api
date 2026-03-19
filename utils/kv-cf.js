const KV_GET_MAX_ATTEMPTS = 5;
const KV_RETRY_BASE_DELAY_MS = 60;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const fetchFromKv = async ({ env, namespace, key, type }) => {
	const kvBinding = env?.[namespace];
	if (!kvBinding) {
		return null;
	}

	for (let attempt = 1; attempt <= KV_GET_MAX_ATTEMPTS; attempt++) {
		try {
			const value = await kvBinding.get(key, { type });
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