export type HttpResponseBody<T> = {
    data: T;
    token: string | null;
};
