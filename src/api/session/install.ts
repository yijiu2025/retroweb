/**
 * 会话接线的**安装函数** —— 能力层。
 *
 * ── 它解决什么 ──
 *   HTTP 层遇到 401 时只知道"该让用户重新登录了"，但**不知道登录弹窗长什么样、
 *   用户数据存在哪、要不要跳转** —— 那是应用层的事。原先这层接线直接写在
 *   `bootstrap.ts` 里：
 *
 *   ```ts
 *   setUnauthorizedHandler((reason: string) => useAuthStore().markExpired(reason));
 *   ```
 *
 *   看着只有一行，却让**入口层知道了 store 的具体方法名**。入口的职责是"装配"，
 *   不该知道被装配的部件怎么用 —— 现在它只调 `installSession()`，具体接线在这里。
 *
 * ── 为什么单独成文件，而不是塞进 stores/auth.ts ──
 *   `stores/auth.ts` → `api/auth` → `api/http` 已是单向依赖。
 *   若把 `setUnauthorizedHandler` 的调用放进 `stores/auth.ts` 的模块顶层，
 *   就变成「import 它的模块顺带装了全局回调」—— 副作用藏在 import 里，
 *   读代码看不出来、测试时也难隔离。做成**显式的 install 函数**、由入口调用，
 *   依赖方向与可见性都更清楚。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
import { setUnauthorizedHandler } from '@/api/http';
import { useAuthStore } from '@/stores/auth';

/**
 * 把「会话失效」接到 auth store 上。**只应在启动时调用一次**（`bootstrap.ts` 第 3 步）。
 *
 * 依赖方向：bootstrap → session → {http, stores/auth}。
 * 🔴 反向不行：`api/http` 若直接 import auth store 就成环（打包器也会报
 *    `INEFFECTIVE_DYNAMIC_IMPORT`）。所以是 http 暴露注册口、这里注入实现。
 *
 * @returns 无（void）；调用后，任意客户端的 401（axios / SSE / `fail()` 兜底）
 *          都会让 `authStore.markExpired(reason)` 被调用，登录弹窗随之出现
 * @returns 无（void）；重复调用是幂等的（后注册覆盖先注册，效果相同）
 */
function installSession(): void {
  // 🔴 回调里**延迟取 store**，不要在这里就取：注册发生在 `app.use(pinia)` 之前。
  //    等到真触发 401（首个会话失效）时，整套插件早已就绪。
  setUnauthorizedHandler((reason: string) => {
    void useAuthStore().markExpired(reason);
  });
}

export { installSession };
