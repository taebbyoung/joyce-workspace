export type AsyncDataState<T> = {
  data: T | null;
  hasLoaded: boolean;
  isInitialLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
};

export function createAsyncDataState<T>(
  data: T | null = null,
): AsyncDataState<T> {
  return {
    data,
    hasLoaded: data !== null,
    isInitialLoading: false,
    isRefreshing: false,
    error: null,
  };
}

export function beginAsyncDataLoad<T>(
  state: AsyncDataState<T>,
): AsyncDataState<T> {
  return {
    ...state,
    error: null,
    isInitialLoading: !state.hasLoaded,
    isRefreshing: state.hasLoaded,
  };
}

export function resolveAsyncData<T>(
  data: T,
): AsyncDataState<T> {
  return {
    data,
    hasLoaded: true,
    isInitialLoading: false,
    isRefreshing: false,
    error: null,
  };
}

export function rejectAsyncData<T>(
  state: AsyncDataState<T>,
  error: string,
): AsyncDataState<T> {
  return {
    ...state,
    isInitialLoading: false,
    isRefreshing: false,
    error,
  };
}

export function updateAsyncData<T>(
  state: AsyncDataState<T>,
  data: T | null,
): AsyncDataState<T> {
  return {
    ...state,
    data,
    hasLoaded: data !== null || state.hasLoaded,
    error: data !== null ? null : state.error,
  };
}
