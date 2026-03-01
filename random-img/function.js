import { detailedErrorResponse, jsonSuccessResponse } from "../main/response.js";

// ===========================
// 随机图片 API 配置
// ===========================
const RANDOM_IMG_CONFIG = {
	BASE_IMAGE_URL_KEY: "BASE_IMAGE_URL", 			// KV 存储中图片基础路径的键名
	FOLDER_MAP_KEY: "FOLDER_MAP", 					// KV 存储中目录映射的键名
	KV_NAMESPACE: "random-img-config", 				// KV 命名空间
	FOLDER_MAP_CACHE_TTL_MS: 60 * 1000, 			// FOLDER_MAP 本地缓存时长（毫秒）
	BASE_IMAGE_URL_CACHE_TTL_MS: 60 * 1000, 		// BASE_IMAGE_URL 本地缓存时长（毫秒）
	ALLOWED_PARAMS: new Set(["d", "b", "t", "m"]), 	// 允许的查询参数：d->device, b->brightness, t->theme, m->method
	REQUEST_VALID_DEVICES: new Set(["pc", "mb", "r"]),	// 请求参数允许的设备类型（r 表示随机设备）
	FOLDER_MAP_VALID_DEVICES: new Set(["pc", "mb"]),	// FOLDER_MAP 配置允许的设备类型（不包含 r）
	VALID_BRIGHTNESS: new Set(["dark", "light"]),  	// 合法明暗类型
	VALID_METHODS: new Set(["proxy", "redirect"]), 	// 合法方法（proxy、redirect）
};

const REQUEST_VALID_DEVICES_LIST = Array.from(RANDOM_IMG_CONFIG.REQUEST_VALID_DEVICES);
const FOLDER_MAP_VALID_DEVICES_LIST = Array.from(RANDOM_IMG_CONFIG.FOLDER_MAP_VALID_DEVICES);
const VALID_BRIGHTNESS_LIST = Array.from(RANDOM_IMG_CONFIG.VALID_BRIGHTNESS);
const VALID_METHODS_LIST = Array.from(RANDOM_IMG_CONFIG.VALID_METHODS);
// 预计算 Set 对应的数组，避免在请求路径中重复 Array.from

// 复用同一个 EdgeKV 客户端，避免重复创建实例
const edgeKV = new EdgeKV({ namespace: RANDOM_IMG_CONFIG.KV_NAMESPACE });

// ===========================
// 随机图片 API 错误定义
// ===========================
const RANDOM_IMG_ERRORS = {
	INVALID_QUERY_PARAMS: { status: 400, message: "Bad Request: Invalid query parameters" },
	INVALID_DEVICE: { status: 400, message: "Bad Request: Invalid device" },
	INVALID_BRIGHTNESS: { status: 400, message: "Bad Request: Invalid brightness" },
	INVALID_THEME: { status: 400, message: "Bad Request: Invalid theme" },
	INVALID_METHOD: { status: 400, message: "Bad Request: Invalid method" },
	BASE_IMAGE_URL_CONFIG_ERROR: { status: 500, message: "Internal Server Error: BASE_IMAGE_URL is invalid or missing in KV" },
	FOLDER_MAP_CONFIG_ERROR: { status: 500, message: "Internal Server Error: FOLDER_MAP is invalid or missing in KV" },
	NO_IMAGES_FOR_COMBINATION: { status: 404, message: "Not Found: No available images for the selected filters" },
	NO_AVAILABLE_IMAGES: { status: 404, message: "Not Found: No available images" },
	UPSTREAM_BAD_STATUS: { status: 502, message: "Bad Gateway: Upstream image service responded with a non-success status" },
	UPSTREAM_FETCH_EXCEPTION: { status: 502, message: "Bad Gateway: Failed to reach upstream image service due to network/runtime exception" },
};

const FOLDER_MAP_CONFIG_ERROR_DETAILS = {
	configKey: RANDOM_IMG_CONFIG.FOLDER_MAP_KEY,
	namespace: RANDOM_IMG_CONFIG.KV_NAMESPACE,
	hint: "Ensure FOLDER_MAP exists in KV and contains a valid JSON object",
};

const BASE_IMAGE_URL_CONFIG_ERROR_DETAILS = {
	configKey: RANDOM_IMG_CONFIG.BASE_IMAGE_URL_KEY,
	namespace: RANDOM_IMG_CONFIG.KV_NAMESPACE,
	hint: "Ensure BASE_IMAGE_URL exists in KV and is a non-empty URL string",
};

// 基于字段名、收到的值与允许值构造统一的参数校验错误响应。
const invalidFieldError = (error, field, received, allowed) =>
	detailedErrorResponse(error, { field, received, allowed });

// 检查查询参数是否都在白名单内，若存在非法参数则直接返回 400 错误响应。
const validateAllowedQueryParams = (params, allowedParams) => {
	// 遍历请求中出现的每个查询参数键。
	for (const key of params.keys()) {
		// 若当前参数不在允许集合中，则立即返回错误。
		if (!allowedParams.has(key)) {
			return detailedErrorResponse(RANDOM_IMG_ERRORS.INVALID_QUERY_PARAMS, {
				invalidParams: [key],
				allowedParams: Array.from(allowedParams),
			});
		}
	}
	// 若不存在非法参数，则返回 null 表示通过校验。
	return null;
};

let folderMapCache = {
	value: null,
	expiresAt: 0,
};
// 进程内缓存：仅在当前边缘实例复用，跨实例/冷启动不共享

let baseImageUrlCache = {
	value: null,
	expiresAt: 0,
};
// 进程内缓存：仅在当前边缘实例复用，跨实例/冷启动不共享

// 从 KV 读取文本值并做 trim 归一化，读取失败或非字符串时返回 null。
const getKvText = async (key) => {
	try {
		// 以文本模式读取指定 KV 键的值。
		const value = await edgeKV.get(key, { type: "text" });
		// 若读取结果不是字符串，则按无效值处理。
		if (typeof value !== "string") {
			return null;
		}
		// 去除字符串首尾空白以统一后续解析行为。
		const trimmed = value.trim();
		// 若去空白后为空字符串，则返回 null。
		return trimmed || null;
	} catch {
		// 读取异常统一降级为 null，避免抛出运行时错误。
		return null;
	}
};

// 判断传入值是否为可用于配置校验的普通对象（排除 null 与数组）。
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// 逐层校验 FOLDER_MAP 的 device/brightness/theme 结构与计数合法性。
const validateFolderMap = (folderMap) => {
	// 首先确认根节点是普通对象结构。
	if (!isPlainObject(folderMap)) {
		return false;
	}

	// 读取顶层 device 键列表用于后续逐层校验。
	const deviceKeys = Object.keys(folderMap);
	// 顶层为空对象时视为无效配置。
	if (deviceKeys.length === 0) {
		return false;
	}

	// 逐个校验 device 维度。
	for (const device of deviceKeys) {
		// 仅允许在 FOLDER_MAP 中出现配置设备集合里的值。
		if (!RANDOM_IMG_CONFIG.FOLDER_MAP_VALID_DEVICES.has(device)) {
			return false;
		}

		// 读取当前 device 下 brightness 映射。
		const brightnessMap = folderMap[device];
		// brightness 层不是对象时判定为无效。
		if (!isPlainObject(brightnessMap)) {
			return false;
		}

		// 逐个校验 brightness 维度。
		for (const brightness of Object.keys(brightnessMap)) {
			// brightness 值必须在允许集合中。
			if (!RANDOM_IMG_CONFIG.VALID_BRIGHTNESS.has(brightness)) {
				return false;
			}

			// 读取当前 brightness 下的 theme 映射。
			const themeMap = brightnessMap[brightness];
			// theme 层不是对象时判定为无效。
			if (!isPlainObject(themeMap)) {
				return false;
			}

			// 逐个校验 theme 与对应 count。
			for (const [theme, count] of Object.entries(themeMap)) {
				// theme 为空、count 非数字或为负数时判定无效。
				if (!theme || !Number.isFinite(Number(count)) || Number(count) < 0) {
					return false;
				}
			}
		}
	}

	return true;
};

// 读取并校验 FOLDER_MAP，优先命中内存缓存并返回统一的 { folderMap, errorKey } 结构。
const getFolderMapFromKV = async () => {
	// 命中 TTL 时直接复用，减少 KV 读取与 JSON 解析成本
	// 判断当前实例缓存是否仍在有效期。
	if (folderMapCache.value && Date.now() < folderMapCache.expiresAt) {
		return { folderMap: folderMapCache.value, errorKey: null };
	}

	// 从 KV 拉取 FOLDER_MAP 原始文本。
	const rawValue = await getKvText(RANDOM_IMG_CONFIG.FOLDER_MAP_KEY);
	// 若 KV 未配置或读取为空，返回统一配置错误键。
	if (!rawValue) {
		return { folderMap: null, errorKey: "FOLDER_MAP_CONFIG_ERROR" };
	}

	// 声明解析结果变量，便于 try/catch 后统一使用。
	let parsed;
	try {
		// 解析 JSON 文本为对象结构。
		parsed = JSON.parse(rawValue);
	} catch {
		// JSON 解析失败时返回配置错误键。
		return { folderMap: null, errorKey: "FOLDER_MAP_CONFIG_ERROR" };
	}

	// 对解析后的对象做结构与数值合法性校验。
	if (!validateFolderMap(parsed)) {
		return { folderMap: null, errorKey: "FOLDER_MAP_CONFIG_ERROR" };
	}

	// 将合法配置写入本地缓存并刷新过期时间。
	folderMapCache = {
		value: parsed,
		expiresAt: Date.now() + RANDOM_IMG_CONFIG.FOLDER_MAP_CACHE_TTL_MS,
	};
	// 缓存写回：后续同实例请求在 TTL 内可直接命中

	return { folderMap: parsed, errorKey: null };
};

// 读取 BASE_IMAGE_URL 并规范成以 `/` 结尾的可拼接基础地址（含本地缓存）。
const getBaseImageUrlFromKV = async () => {
	// 若基础 URL 本地缓存仍有效，则直接复用。
	if (baseImageUrlCache.value && Date.now() < baseImageUrlCache.expiresAt) {
		return baseImageUrlCache.value;
	}

	// 从 KV 读取基础 URL 文本。
	const normalizedUrl = await getKvText(RANDOM_IMG_CONFIG.BASE_IMAGE_URL_KEY);
	// 若为空则表示配置缺失或无效。
	if (!normalizedUrl) {
		return null;
	}

	// 确保 URL 末尾包含 `/` 便于后续路径拼接。
	const normalizedWithSlash = normalizedUrl.endsWith("/") ? normalizedUrl : `${normalizedUrl}/`;
	// 写入本地缓存并设置过期时间。
	baseImageUrlCache = {
		value: normalizedWithSlash,
		expiresAt: Date.now() + RANDOM_IMG_CONFIG.BASE_IMAGE_URL_CACHE_TTL_MS,
	};

	return normalizedWithSlash;
};

// ===========================
// 随机图片主处理逻辑
// ===========================
export const handleRandomImg = async (request) => {
	// 处理随机图片请求：参数校验 -> 候选组合筛选 -> 加权抽样 -> redirect/proxy 返回。
	// 解析请求 URL 以获取路径与查询参数。
	const url = new URL(request.url);
	// 提取 URLSearchParams 便于读取与校验参数。
	const params = url.searchParams;

	// 第一步：优先校验链接参数合法性，再做后续处理
	// 执行参数白名单校验，返回值为 null 或错误响应对象。
	const invalidParamsResponse = validateAllowedQueryParams(params, RANDOM_IMG_CONFIG.ALLOWED_PARAMS);
	// 若存在非法参数，直接返回错误响应并中止流程。
	if (invalidParamsResponse) {
		return invalidParamsResponse;
	}

	// 读取 method 参数，缺省时默认使用 proxy。
	const method = params.get("m")?.toLowerCase() || "proxy";

	// 校验 method 参数：仅允许 proxy 或 redirect（优先返回，避免无效请求触发 KV 读取）
	// 判断 method 是否在允许集合内。
	if (!RANDOM_IMG_CONFIG.VALID_METHODS.has(method)) {
		return invalidFieldError(RANDOM_IMG_ERRORS.INVALID_METHOD, "m", method, VALID_METHODS_LIST);
	}

	// 读取请求指定的设备参数（若未传则为 null）。
	const requestedDevice = params.get("d")?.toLowerCase() || null;
	// 若传入了设备参数，则校验其是否属于请求允许集合。
	if (requestedDevice && !RANDOM_IMG_CONFIG.REQUEST_VALID_DEVICES.has(requestedDevice)) {
		return invalidFieldError(RANDOM_IMG_ERRORS.INVALID_DEVICE, "d", requestedDevice, REQUEST_VALID_DEVICES_LIST);
	}

	// 读取 User-Agent 以便在未指定设备时做端侧推断。
	const userAgent = request.headers.get("User-Agent") || "";
	// 通过 UA 关键字判断是否移动端。
	const isMobile = /Mobi|Android|iPhone/i.test(userAgent);
	// 优先使用显式设备参数，否则按 UA 推断默认设备。
	const device = requestedDevice || (isMobile ? "mb" : "pc");
	// 读取亮度参数（若未传则为 null）。
	const requestedBrightness = params.get("b")?.toLowerCase() || null;
	// 若传入亮度参数，则校验其合法性。
	if (requestedBrightness && !RANDOM_IMG_CONFIG.VALID_BRIGHTNESS.has(requestedBrightness)) {
		return invalidFieldError(RANDOM_IMG_ERRORS.INVALID_BRIGHTNESS, "b", requestedBrightness, VALID_BRIGHTNESS_LIST);
	}

	// 读取并归一化 theme 参数：支持多次传参与逗号分隔，最终去重。
	const themeParams = Array.from(new Set(params
		.getAll("t")
		.flatMap((value) => value.split(","))
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean)));

	// 处理 device 参数
	const deviceCandidates =
		device === "r"
			? FOLDER_MAP_VALID_DEVICES_LIST
			: [device];

	// 处理 brightness 参数
	// 若指定亮度则只用该值，否则使用全部亮度候选。
	const brightnessCandidates = requestedBrightness ? [requestedBrightness] : VALID_BRIGHTNESS_LIST;

	// 读取并校验 FOLDER_MAP 配置。
	const { folderMap, errorKey: folderMapErrorKey } = await getFolderMapFromKV();
	// 若配置异常则返回统一配置错误响应。
	if (folderMapErrorKey) {
		return detailedErrorResponse(RANDOM_IMG_ERRORS[folderMapErrorKey], FOLDER_MAP_CONFIG_ERROR_DETAILS);
	}

	// 处理 theme 参数
	// 从 FOLDER_MAP 中汇总全部有效主题并做去重。
	const validThemes = Array.from(
		new Set(
			Object.values(folderMap).flatMap((deviceMap) =>
				Object.values(deviceMap ?? {}).flatMap((brightnessMap) =>
					Object.keys(brightnessMap ?? {})
				)
			)
		)
	);
	// 将有效主题数组转为 Set 以提升校验效率。
	const validThemesSet = new Set(validThemes);
	// 找到首个非法主题（若均合法则为 undefined）。
	const invalidTheme = themeParams.find((candidateTheme) => !validThemesSet.has(candidateTheme));
	// 若存在非法主题参数，则返回字段错误响应。
	if (invalidTheme) {
		return invalidFieldError(RANDOM_IMG_ERRORS.INVALID_THEME, "t", invalidTheme, validThemes);
	}
	// 若请求未指定主题，则默认以所有有效主题作为候选。
	const themeCandidates = themeParams.length > 0 ? themeParams : validThemes;

	// 初始化候选组合列表，用于后续加权随机抽样。
	const candidates = [];
	// 遍历设备候选集合。
	for (const candidateDevice of deviceCandidates) {
		// 读取当前设备下的配置映射。
		const deviceMap = folderMap[candidateDevice];
		// 遍历亮度候选集合。
		for (const b of brightnessCandidates) {
			// 遍历主题候选集合。
			for (const t of themeCandidates) {
				// 读取当前组合的图片数量，缺省按 0 处理。
				const count = deviceMap[b]?.[t] ?? 0;
				// 仅将 count 大于 0 的组合纳入候选池。
				if (count > 0) {
					candidates.push({ device: candidateDevice, brightness: b, theme: t, count });
				}
			}
		}
	}

	// 若候选池为空，则根据是否传过滤条件返回不同的 404 错误。
	if (candidates.length === 0) {
		// 指定了亮度或主题但无结果时，返回组合无图错误并回显过滤条件。
		if (requestedBrightness || themeParams.length > 0) {
			return detailedErrorResponse(RANDOM_IMG_ERRORS.NO_IMAGES_FOR_COMBINATION, {
				filters: {
					device,
					brightness: requestedBrightness,
					themes: themeCandidates,
				},
			});
		}
		// 未指定过滤条件且仍无可用图时，返回通用无图错误。
		return detailedErrorResponse(RANDOM_IMG_ERRORS.NO_AVAILABLE_IMAGES, {
			hint: "Check FOLDER_MAP counts in KV to ensure at least one image count is greater than 0",
		});
	}

	// 加权抽样：按 count 作为权重选择候选组合，保证“每张图”更接近等概率
	// 计算候选池总权重（各组合 count 之和）。
	const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.count, 0);
	// 在 [1, totalWeight] 区间生成随机权重点。
	const randomWeight = Math.floor(Math.random() * totalWeight) + 1;
	// 初始化累积权重，用于定位命中的候选组合。
	let accumulatedWeight = 0;
	// 预置默认选中项，保证变量始终有值。
	let selectedFolder = candidates[0];
	// 线性累积权重，命中随机权重点时结束循环。
	for (const candidate of candidates) {
		accumulatedWeight += candidate.count;
		if (accumulatedWeight >= randomWeight) {
			selectedFolder = candidate;
			break;
		}
	}

	// 读取基础图片 URL 配置。
	const baseImageUrl = await getBaseImageUrlFromKV();
	// 若基础 URL 缺失或无效，则返回配置错误。
	if (!baseImageUrl) {
		return detailedErrorResponse(RANDOM_IMG_ERRORS.BASE_IMAGE_URL_CONFIG_ERROR, BASE_IMAGE_URL_CONFIG_ERROR_DETAILS);
	}

	// 随机选取图片编号
	// 在当前选中目录范围内随机生成图片序号（从 1 开始）。
	const imageNumber = Math.floor(Math.random() * selectedFolder.count) + 1;
	// 生成固定 6 位补零文件名（如 000123.webp）。
	const imageFilename = `${String(imageNumber).padStart(6, "0")}.webp`;
	// 拼接最终上游图片 URL。
	const imageUrl = `${baseImageUrl}${selectedFolder.device}-${selectedFolder.brightness}/${selectedFolder.theme}/${imageFilename}`;

	// method=redirect 返回 302；method=proxy 透传图片内容
	if (method === "redirect") {
		return new Response(null, {
			status: 302,
			headers: { Location: imageUrl },
		});
	}

	try {
		// 以 proxy 方式请求上游图片资源。
		const upstreamResponse = await fetch(imageUrl);

		// 上游返回非 2xx 时，转换为统一 502 错误响应。
		if (!upstreamResponse.ok) {
			return detailedErrorResponse(RANDOM_IMG_ERRORS.UPSTREAM_BAD_STATUS, {
				upstreamStatus: upstreamResponse.status,
				upstreamStatusText: upstreamResponse.statusText || undefined,
				hint: "Upstream responded but did not return a success status",
			});
		}

		// 复制上游响应头，尽量保留原始元数据。
		const headers = new Headers(upstreamResponse.headers);
		// 若上游未设置缓存头，则补一个默认缓存策略。
		if (!headers.has("Cache-Control")) {
			headers.set("Cache-Control", "public, max-age=3600");
		}

		// 透传上游响应体与状态码给客户端。
		return new Response(upstreamResponse.body, {
			status: upstreamResponse.status,
			headers,
		});
	} catch {
		// 请求上游过程中发生运行时异常时返回统一 502 错误。
		return detailedErrorResponse(RANDOM_IMG_ERRORS.UPSTREAM_FETCH_EXCEPTION, {
			hint: "Upstream request failed before receiving a valid response",
		});
	}
};

const buildRandomImgCountData = (folderMap) => {
	const groupTotals = {};
	const themeTotals = {};
	const themeDetails = [];
	let totalImages = 0;
	for (const device of Object.keys(folderMap).sort()) {
		for (const brightness of Object.keys(folderMap[device]).sort()) {
			const groupKey = `${device}-${brightness}`;
			let groupTotal = 0;
			for (const theme of Object.keys(folderMap[device][brightness]).sort()) {
				const count = Number(folderMap[device][brightness][theme] ?? 0);
				groupTotal += count;
				totalImages += count;
				themeTotals[theme] = (themeTotals[theme] ?? 0) + count;
				themeDetails.push({ theme, device, brightness, count });
			}
			groupTotals[groupKey] = groupTotal;
		}
	}
	themeDetails.sort((a, b) =>
		a.theme.localeCompare(b.theme) ||
		a.device.localeCompare(b.device) ||
		a.brightness.localeCompare(b.brightness)
	);
	return {
		totalImages,
		groupTotals,
		themeTotals,
		themeDetails,
	};
};

export const handleRandomImgCount = async (request) => {
	const url = new URL(request.url);
	if (url.pathname !== "/random-img-count" || url.search) {
		return new Response(null, { status: 403 });
	}
	const { folderMap, errorKey: folderMapErrorKey } = await getFolderMapFromKV();
	if (folderMapErrorKey) {
		return new Response(null, { status: 204 });
	}
	return jsonSuccessResponse(buildRandomImgCountData(folderMap));
};
