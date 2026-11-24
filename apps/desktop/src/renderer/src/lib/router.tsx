import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';

/** 界面里的"页面地址"。没有用 URL 路由：桌面应用不需要，状态放内存里更简单。 */
export type Route =
  | { page: 'home' }
  | { page: 'create' }
  | { page: 'world'; worldId: string; tab?: 'collection' | 'assets' }
  | { page: 'play'; worldId: string; playthroughId: string }
  | { page: 'playground' }
  | { page: 'logs' }
  | { page: 'settings' };

export type PageId = Route['page'];

interface RouterState {
  route: Route;
  navigate: (r: Route) => void;
}

const RouterContext = createContext<RouterState>({ route: { page: 'home' }, navigate: () => {} });

export function RouterProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>({ page: 'home' });
  const navigate = useCallback((r: Route) => setRoute(r), []);
  return <RouterContext.Provider value={{ route, navigate }}>{children}</RouterContext.Provider>;
}

export function useRouter() {
  return useContext(RouterContext);
}
