export const detailedErrorResponse = (error, details = undefined, spaces = 2) => {
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

export const jsonErrorResponse = (error, spaces = 2) => detailedErrorResponse(error, undefined, spaces);