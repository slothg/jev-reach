/**
 * 在共享后端维护整轮预览测试占用与 FIFO 预约。
 * QA 外部活动须确认 Runtime 清理后才能交接；定时器不延长进程存活。
 */
import { randomUUID } from "node:crypto";

/** 一个后端连接的清理责任。 */
type Member = {
  /** 在单次操作队列中清理该连接的浏览器资源。 */
  cleanup: () => Promise<void>;
  /** 是否还须由 QA 主机确认外部 Runtime 已停止。 */
  externalCleanup: boolean;
  /** 原 MCP 连接已断开，仅允许持凭证恢复清理。 */
  disconnected?: boolean;
};
/** 当前整轮测试的占用状态。 */
type Lease = {
  /** 本轮占用的唯一标识。 */
  id: string;
  /** 本地子连接关联能力凭证，不出现在公共状态查询中。 */
  token: string;
  /** 取得占用的根连接标识。 */
  owner: string;
  /** 同一聊天组内尚未确认清理的连接。 */
  members: Set<string>;
  /** 最近实际活动时间，毫秒。 */
  touched: number;
  /** 尚未结束的浏览器调用与 QA 活动数量。 */
  active: number;
  /** 已撤销新操作，正在等待清理交接。 */
  closing: boolean;
  /** 清理失败原因；存在时禁止交接。 */
  error?: string;
};
/** 不保存输入正文的 FIFO 预约。 */
type Ticket = {
  /** 最近申请时间，毫秒，状态查询不续期。 */
  touched: number;
  /** 当前有界等待请求的唤醒回调。 */
  wake: Set<() => void>;
};

/** 在单次浏览器队列之外等待整轮测试占用，避免阻塞清理。 */
export class PreviewQueue {
  #members = new Map<string, Member>();
  #tickets = new Map<string, Ticket>();
  #activities = new Map<string, string>();
  #lease?: Lease;
  #retiring?: Promise<void>;
  #settled = new Set<() => void>();
  #timer: NodeJS.Timeout;

  /**
   * 初始化占用与预约期限；注入时钟仅用于本地限定测试。
   * @param idleMs 闲置回收期限，毫秒，默认 10 分钟。
   * @param now 返回当前毫秒时间的时钟。
   * @param ticketMs 未续期预约的期限，毫秒，默认 2 分钟。
   */
  constructor(
    private idleMs = 600_000,
    private now: () => number = Date.now,
    private ticketMs = 120_000,
  ) {
    this.#timer = setInterval(() => { void this.sweep(); }, 1000);
    this.#timer.unref();
  }

  /**
   * 将清理责任绑定到服务端连接，而非客户端显示名称。
   * @param owner 服务端生成的连接标识。
   * @param cleanup 仅清理该连接浏览器资源的回调。
   */
  register(owner: string, cleanup: () => Promise<void>): void {
    this.#members.set(owner, { cleanup, externalCleanup: false });
  }

  /**
   * 读取公共队列状态，不续期或暴露其他连接的关联凭证。
   * @param owner 查询者的服务端连接标识。
   * @returns 占用者、等待位置及本连接是否拥有占用。
   */
  status(owner: string) {
    const lease = this.#lease;
    return {
      status: lease?.closing ? "RELEASING" : lease ? "HELD" : "IDLE",
      leaseId: lease?.id ?? null, ownerId: lease?.owner ?? null,
      owned: !!lease?.members.has(owner), position: [...this.#tickets.keys()].indexOf(owner) + 1,
      waiting: this.#tickets.size, active: lease?.active ?? 0,
      members: lease?.members.size ?? 0, cleanupFailure: lease?.error ?? null,
      memberId: lease?.members.has(owner) ? owner : null,
    };
  }

  /**
   * 申请、关联或有界等待；恢复连接只能接管已断开的清理责任。
   * @param owner 当前服务端连接标识。
   * @param waitMs 等待毫秒数，最多 30000，默认不等待。
   * @param token 可选的本地关联凭证。
   * @param externalCleanup 是否需要外部 Runtime 清理确认。
   * @param signal 取消当前等待的请求信号。
   * @param cleanupMemberId 恢复清理时的旧连接标识。
   * @returns HELD 可执行测试；QUEUED 未执行；RELEASING 仅可清理。
   */
  async acquire(owner: string, waitMs = 0, token?: string, externalCleanup = false, signal?: AbortSignal, cleanupMemberId?: string) {
    signal?.throwIfAborted();
    if (!this.#members.has(owner)) throw new Error("PREVIEW_SESSION_CLOSED");
    await this.sweep();
    signal?.throwIfAborted();
    const member = this.#members.get(owner)!;
    const lease = this.#lease;
    if (cleanupMemberId !== undefined) {
      const orphan = this.#members.get(cleanupMemberId);
      if (!lease?.closing || token !== lease.token || !lease.members.has(cleanupMemberId) || !orphan?.disconnected) {
        throw new Error("PREVIEW_LEASE_INVALID");
      }
      await orphan.cleanup();
      if (this.#lease !== lease || !lease.members.has(cleanupMemberId)
        || this.#members.get(cleanupMemberId) !== orphan || !this.#members.has(owner)) {
        throw new Error("PREVIEW_SESSION_CLOSED");
      }
      for (const [activity, member] of this.#activities) {
        if (member === cleanupMemberId) this.endActivity(cleanupMemberId, activity);
      }
      lease.members.delete(cleanupMemberId);
      lease.members.add(owner);
      if (lease.owner === cleanupMemberId) lease.owner = owner;
      this.#members.delete(cleanupMemberId);
      member.externalCleanup = true;
      return { ...this.status(owner), leaseToken: lease.token };
    }
    if (token !== undefined) {
      if (!lease || lease.closing || token !== lease.token) throw new Error("PREVIEW_LEASE_INVALID");
      lease.members.add(owner);
      this.#tickets.delete(owner);
    }
    if (this.#lease?.members.has(owner)) {
      if (this.#lease.closing) return this.status(owner);
      member.externalCleanup ||= externalCleanup;
      return { ...this.status(owner), leaseToken: this.#lease.token };
    }
    let ticket = this.#tickets.get(owner);
    if (!ticket) {
      ticket = { touched: this.now(), wake: new Set() };
      this.#tickets.set(owner, ticket);
    } else ticket.touched = this.now();
    const admit = () => {
      if (this.#lease || this.#tickets.keys().next().value !== owner) return false;
      this.#tickets.delete(owner);
      this.#lease = { id: randomUUID(), token: randomUUID(), owner, members: new Set([owner]),
        touched: this.now(), active: 0, closing: false };
      member.externalCleanup ||= externalCleanup;
      return true;
    };
    if (!admit() && waitMs > 0) {
      await new Promise<void>(resolve => {
        const finish = () => {
          clearTimeout(timer); ticket!.wake.delete(finish);
          signal?.removeEventListener("abort", finish); resolve();
        };
        const timer = setTimeout(finish, Math.min(30_000, waitMs));
        ticket!.wake.add(finish);
        signal?.addEventListener("abort", finish, { once: true });
        if (signal?.aborted) finish();
      });
      if (signal?.aborted) {
        this.cancel(owner); signal.throwIfAborted();
      }
      if (!this.#members.has(owner)) throw new Error("PREVIEW_SESSION_CLOSED");
      admit();
    }
    if (this.#lease?.members.has(owner)) return { ...this.status(owner), leaseToken: this.#lease.token };
    return { ...this.status(owner), status: "QUEUED", executed: false };
  }

  /**
   * 撤销预约；不会释放正在持有的占用。
   * @param owner 待取消的连接标识。
   */
  cancel(owner: string): void {
    const ticket = this.#tickets.get(owner);
    const wasFirst = this.#tickets.keys().next().value === owner;
    this.#tickets.delete(owner);
    ticket?.wake.forEach(wake => wake());
    if (wasFirst) this.#wake();
  }

  /**
   * 保持当前活动，防止其执行期间发生闲置回收。
   * @param owner 已拥有本轮占用的连接标识。
   * @returns 须在 finally 中确认结束的活动标识。
   */
  beginActivity(owner: string): string {
    const lease = this.#require(owner);
    const activity = randomUUID();
    this.#activities.set(activity, owner);
    lease.active++;
    lease.touched = this.now();
    return activity;
  }

  /**
   * 在实际进入单次操作队列时再次检查占用，拒绝迟到的旧操作。
   * @param owner 待执行操作的连接标识。
   */
  assertOwner(owner: string): void {
    this.#require(owner);
  }

  /**
   * 结束一项活动，拒绝重复或跨连接确认。
   * @param owner 发起活动的连接标识。
   * @param activity beginActivity 返回的活动标识。
   */
  endActivity(owner: string, activity: string): void {
    if (this.#activities.get(activity) !== owner) throw new Error("PREVIEW_ACTIVITY_INVALID");
    this.#activities.delete(activity);
    if (this.#lease) {
      this.#lease.active--;
      this.#lease.touched = this.now();
    }
    this.#finish();
    this.#settled.forEach(wake => wake());
  }

  /**
   * 检查撤销中的连接是否仍可清理自身资源。
   * @param owner 待清理连接标识。
   * @returns 该连接是否仍属于本轮占用。
   */
  canCleanup(owner: string): boolean {
    return !!this.#lease?.members.has(owner);
  }

  /**
   * 根连接释放会撤销整组；QA 连接须先清理 Runtime 再确认交接。
   * @param owner 发起释放的连接标识。
   * @param disconnected 原 MCP 连接是否已断开。
   * @returns 清理后的公共状态，可能仍为 RELEASING。
   */
  async release(owner: string, disconnected = false) {
    this.cancel(owner);
    const lease = this.#lease;
    if (lease?.members.has(owner)) {
      if (owner === lease.owner) lease.closing = true;
      const ownMember = this.#members.get(owner);
      if (disconnected && ownMember?.externalCleanup) {
        // Runtime may still be executing. Its host must detach and acknowledge via a new connection.
        lease.closing = true;
        ownMember.disconnected = true;
        return this.status(owner);
      }
      if (disconnected) for (const [activity, member] of this.#activities) {
        if (member === owner) this.endActivity(owner, activity);
      }
      while (lease.active) {
        await new Promise<void>(resolve => {
          const wake = () => { this.#settled.delete(wake); resolve(); };
          this.#settled.add(wake);
        });
      }
      // Cleanup is serialized by the registered server callback, after already-running tools.
      try {
        await this.#members.get(owner)?.cleanup();
        lease.members.delete(owner);
        if (owner === lease.owner) {
          for (const other of [...lease.members]) {
            const delegated = this.#members.get(other);
            if (delegated && !delegated.externalCleanup) {
              await delegated.cleanup();
              lease.members.delete(other);
            }
          }
        }
      } catch (error) {
        lease.closing = true;
        lease.error = error instanceof Error ? error.message : String(error);
      }
      this.#finish();
    }
    if (disconnected) this.#members.delete(owner);
    return this.status(owner);
  }

  /**
   * 回收过期预约及无活动的闲置占用；QA 主机确认前保持阻塞。
   * @returns 本轮闲置清理完成的 Promise。
   */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const [owner, ticket] of this.#tickets) {
      if (now - ticket.touched >= this.ticketMs) this.cancel(owner);
    }
    const lease = this.#lease;
    if (this.#retiring) return this.#retiring;
    if (!lease || lease.closing || lease.active || now - lease.touched < this.idleMs) return;
    lease.closing = true;
    this.#retiring = (async () => {
      if (!this.#members.get(lease.owner)?.externalCleanup) await this.release(lease.owner);
    })().finally(() => { this.#retiring = undefined; });
    await this.#retiring;
  }

  /** 服务退出时停止定时器并取消预约，不执行浏览器操作。 */
  close(): void {
    clearInterval(this.#timer);
    for (const owner of this.#tickets.keys()) this.cancel(owner);
  }

  /**
   * 验证连接仍拥有可执行的占用，否则抛出 PREVIEW_LEASE_LOST。
   * @param owner 待验证的连接标识。
   * @returns 当前有效占用。
   */
  #require(owner: string): Lease {
    const lease = this.#lease;
    if (!lease || lease.closing || !lease.members.has(owner)) throw new Error("PREVIEW_LEASE_LOST");
    return lease;
  }

  /** 仅在全部成员与活动清理完成、且没有清理失败时交接。 */
  #finish(): void {
    if (this.#lease?.closing && !this.#lease.members.size && !this.#lease.active && !this.#lease.error) {
      this.#lease = undefined;
      this.#wake();
    }
  }

  /** 唤醒首个预约，由其再次申请确认，避免给无人等待的连接占用。 */
  #wake(): void {
    this.#tickets.values().next().value?.wake.forEach(wake => wake());
  }
}
