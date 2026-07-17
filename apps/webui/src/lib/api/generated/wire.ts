import type { paths } from "./schema";

export type HttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
type LowerMethod<M extends HttpMethod> = Lowercase<M>;

type PathForMethod<M extends HttpMethod> = {
	[P in keyof paths]: LowerMethod<M> extends keyof paths[P]
		? paths[P][LowerMethod<M>] extends never
			? never
			: P
		: never;
}[keyof paths];

type Operation<M extends HttpMethod, P extends PathForMethod<M>> = NonNullable<
	paths[P][LowerMethod<M> & keyof paths[P]]
>;

type Parameter<O, K extends "path" | "query"> = O extends { parameters: infer Parameters }
	? K extends keyof Parameters
		? Exclude<Parameters[K], undefined>
		: never
	: never;

type JsonRequestBody<O> = O extends { requestBody?: infer Body }
	? Exclude<Body, undefined> extends { content: { "application/json": infer Json } }
		? Json
		: never
	: never;

type JsonContent<Response> = Response extends { content: { "application/json": infer Json } } ? Json : undefined;

type SuccessResponse<O> = O extends { responses: infer Responses }
	? {
			[Status in keyof Responses]: `${Status & (string | number)}` extends `2${string}`
				? JsonContent<Responses[Status]>
				: never;
		}[keyof Responses]
	: never;

export type WireRequestOptions<M extends HttpMethod, P extends PathForMethod<M>> = {
	path?: Parameter<Operation<M, P>, "path">;
	query?: Parameter<Operation<M, P>, "query">;
	body?: JsonRequestBody<Operation<M, P>>;
};

export type WireResponse<M extends HttpMethod, P extends PathForMethod<M>> = SuccessResponse<Operation<M, P>>;

export type WirePath<M extends HttpMethod> = PathForMethod<M>;
