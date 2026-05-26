// 构造包含可选详情字段的 JSON 错误响应
export const jsonErrorResponse = (error, details = undefined, spaces = 2) => {
	const payload = {
		status: error.status,
		message: error.message,
	};

	if (details && Object.keys(details).length > 0) {
		payload.details = details;
	}

	return new Response(JSON.stringify(payload, null, spaces), {
		status: error.status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
};
