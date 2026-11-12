import { Context, Schema, Session, h } from 'koishi'
import { } from 'koishi-plugin-cron'

export const name = 'daily-plan'

export const inject = { required: ['cron', 'database'] }

export interface Config {
  defaultDurationMinutes: number
  repeatMinutes: number
  recallOldReminder: boolean
  defaultSnoozeMinutes: number
}

export const Config: Schema<Config> = Schema.object({
  defaultDurationMinutes: Schema.number()
    .description('Default time window (minutes) if not given on add')
    .default(120).min(1),
  repeatMinutes: Schema.number()
    .description('Remind interval after deadline (minutes)')
    .default(15).min(1),
  recallOldReminder: Schema.boolean()
    .description('Recall the previous reminder message before sending a new one')
    .default(true),
  defaultSnoozeMinutes: Schema.number()
    .description('Default snooze length (minutes) for `plan snooze` without a number')
    .default(30).min(1),
})

declare module 'koishi' {
  interface Tables {
    'daily_plan': PlanRow
    'daily_plan_cycle': CycleRow
  }
}

interface PlanRow {
  id: number
  scope: string
  userId: string
  name: string
  startTime: string      // "HH:mm"
  durationMin: number    // window length in minutes
  enabled: number
  createdAt: Date
  effectiveDate: string      // first cycle date (YYYY-MM-DD); '' = no restriction
  snoozeUntil: Date | null   // reminders are muted while this is in the future
}

/** 每个「计划 × 周期起始日」一个待办实例 */
interface CycleRow {
  id: number
  planId: number
  cycleDate: string      // YYYY-MM-DD of the cycle's start day
  done: number
  doneAt: Date | null
  failed: number
  lastRemindKey: string  // 上次提醒的标记（防重复提醒）
  lastRemindMsgId: string // 上次提醒消息的 id（用于撤回旧提醒）
}

function todayStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function toHalfWidth(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c >= 0xff01 && c <= 0xff5e) out += String.fromCharCode(c - 0xfee0)
    else if (c === 0x3000) out += ' '
    else out += ch
  }
  return out
}

function parseStartTime(t: string): { h: number, m: number } | null {
  const norm = toHalfWidth(t).trim()
  const m = /^(\d{1,2}):(\d{2})$/.exec(norm)
  if (!m) return null
  const h = +m[1]
  const min = +m[2]
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return { h, m: min }
}

function fmtTime(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 周期起点：不晚于 now 的最近一次 startTime（可能是今天或昨天） */
function cycleStart(plan: PlanRow, now: Date): Date {
  const [h, m] = plan.startTime.split(':').map(Number)
  const d = new Date(now)
  d.setHours(h, m, 0, 0)
  if (d > now) d.setDate(d.getDate() - 1)
  return d
}

/** 周期终点 = 下一个开始时间 */
function cycleEnd(plan: PlanRow, now: Date): Date {
  const s = cycleStart(plan, now)
  const e = new Date(s)
  e.setDate(e.getDate() + 1)
  return e
}

/** 截止 = 周期起点 + durationMin */
function deadline(plan: PlanRow, now: Date): Date {
  const s = cycleStart(plan, now)
  return new Date(s.getTime() + plan.durationMin * 60000)
}

function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60000)
}

/**
 * 首次生效的「周期日」= 时钟时间 HH:mm 的**下一个**出现日。
 * - 今天 HH:mm 尚未到达 → 今天（下一个就是这个）
 * - 今天 HH:mm 已经过去 → 明天（下一个出现在明天）
 * 绝不会落到「已经过去的那个 HH:mm」。
 */
function firstCycleDate(plan: { startTime: string }, now: Date): string {
  const [h, m] = plan.startTime.split(':').map(Number)
  const startToday = new Date(now)
  startToday.setHours(h, m, 0, 0)
  if (startToday.getTime() < now.getTime()) {
    const t = new Date(now)
    t.setDate(t.getDate() + 1)
    return todayStr(t)
  }
  return todayStr(now)
}

function isSnoozed(plan: PlanRow, now: Date): boolean {
  return !!plan.snoozeUntil && new Date(plan.snoozeUntil).getTime() > now.getTime()
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('daily-plan')
  const defaultDuration = config.defaultDurationMinutes ?? 120
  const repeatMinutes = config.repeatMinutes ?? 15
  const recallOld = config.recallOldReminder !== false
  const defaultSnooze = config.defaultSnoozeMinutes ?? 30

  ctx.model.extend('daily_plan', {
    id: 'unsigned',
    scope: 'string(255)',
    userId: 'string(63)',
    name: 'string(255)',
    startTime: 'string(8)',
    durationMin: 'integer',
    enabled: 'integer',
    createdAt: 'timestamp',
    effectiveDate: 'string(16)',
    snoozeUntil: 'timestamp',
  }, {
    autoInc: true,
    primary: 'id',
  })

  ctx.model.extend('daily_plan_cycle', {
    id: 'unsigned',
    planId: 'unsigned',
    cycleDate: 'string(16)',
    done: 'integer',
    doneAt: 'timestamp',
    failed: 'integer',
    lastRemindKey: 'string(63)',
    lastRemindMsgId: 'string(96)',
  }, {
    autoInc: true,
    primary: 'id',
    unique: [['planId', 'cycleDate']],
  })

  function resolveChannel(scope: string) {
    const bot = ctx.bots.find((b) => scope.startsWith(b.platform + ':'))
    if (!bot) return null
    const channelId = scope.slice(scope.indexOf(':') + 1)
    return { bot, channelId }
  }

  async function sendToChannel(scope: string, content: any): Promise<string[] | null> {
    const target = resolveChannel(scope)
    if (!target) return null
    try {
      return await target.bot.sendMessage(target.channelId, content)
    } catch (e: any) {
      logger.warn('send failed:', e?.message ?? e)
      return null
    }
  }

  async function recallMessage(scope: string, messageId: string) {
    const target = resolveChannel(scope)
    if (!target) return
    try {
      await target.bot.deleteMessage(target.channelId, messageId)
    } catch (e: any) {
      logger.warn('recall failed:', e?.message ?? e)
    }
  }

  async function getCycle(plan: PlanRow, cycleDate: string): Promise<CycleRow | null> {
    const rows = await ctx.database.get('daily_plan_cycle', { planId: plan.id, cycleDate }) as CycleRow[]
    if (!rows.length) return null
    // 若存在多条（历史脏数据），优先取已完成/已失败的那条
    return rows.find((r) => r.done || r.failed) ?? rows[0]
  }

  async function ensureCycle(plan: PlanRow, cycleDate: string): Promise<CycleRow> {
    let c = await getCycle(plan, cycleDate)
    if (c) return c
    c = await ctx.database.create('daily_plan_cycle', {
      planId: plan.id,
      cycleDate,
      done: 0,
      doneAt: null,
      failed: 0,
      lastRemindKey: '',
      lastRemindMsgId: '',
    }) as CycleRow
    return c
  }

  // ── 提醒检查（每分钟）──
  async function checkAndRemind(now: Date) {
    const plans = await ctx.database.get('daily_plan', { enabled: 1 }) as PlanRow[]

    // ① 先判失败：上一周期窗口已结束仍未 done（静音中或尚未生效的计划跳过）
    for (const p of plans) {
      if (isSnoozed(p, now)) continue
      const prevStart = new Date(cycleStart(p, now))
      prevStart.setDate(prevStart.getDate() - 1)
      const prevDate = todayStr(prevStart)
      if (p.effectiveDate && prevDate < p.effectiveDate) continue
      const c = await getCycle(p, prevDate)
      if (!c || c.done || c.failed) continue
      await ctx.database.set('daily_plan_cycle', { id: c.id }, { failed: 1 })
      await sendToChannel(p.scope, [h('at', { id: p.userId }), h.text(` ❌ 昨日「${p.name}」未完成，判定失败。新一轮已开始。`)])
    }

    // ② 再发提醒
    // 按 scope+startTime+name 合并多人计划，一条消息 @ 多人
    const groups = new Map<string, PlanRow[]>()
    for (const p of plans) {
      if (isSnoozed(p, now)) continue
      const key = `${p.scope}|${p.startTime}|${p.name}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(p)
    }

    for (const [, group] of groups) {
      const start = cycleStart(group[0], now)
      const cd = todayStr(start)
      // 过滤掉尚未生效（effectiveDate 在 cycleDate 之后）的成员
      const members = group.filter((p) => !p.effectiveDate || cd >= p.effectiveDate)
      if (!members.length) continue
      const sample = members[0]
      const dd = deadline(sample, now)

      // 收集需要提醒的成员（未完成、未失败）
      const pending: { plan: PlanRow, cycle: CycleRow }[] = []
      for (const p of members) {
        const c = await ensureCycle(p, cd)
        if (c.done) continue
        if (c.failed) continue
        pending.push({ plan: p, cycle: c })
      }
      if (!pending.length) continue

      // 计算本轮提醒类型（用组内第一个的窗口；成员 duration 一般相同）
      const minsToDeadline = minutesBetween(now, dd)
      const minsSinceStart = minutesBetween(start, now)
      let key = ''
      let text = ''

      if (minsSinceStart < 0) continue // 周期还没开始

      if (minsSinceStart === 0) {
        // 首次提醒：刚开始
        key = 'start'
        text = `⏰ 「${sample.name}」开始啦！请在 ${fmtTime(dd.getHours(), dd.getMinutes())} 前完成（${sample.durationMin} 分钟）`
      } else if (minsToDeadline > 0) {
        // 截止前的节点提醒：仅在恰好等于节点时发（每分钟检查一次）
        const mark = [30, 15, 10, 5].find((m) => m === minsToDeadline)
        if (!mark) continue
        key = `pre${mark}`
        text = `⏰ 「${sample.name}」距离截止还有 ${mark} 分钟（截止 ${fmtTime(dd.getHours(), dd.getMinutes())}）`
      } else {
        // 超时：每 repeatMinutes 一次
        const overdue = -minsToDeadline
        const bucket = Math.floor(overdue / repeatMinutes)
        key = `over${bucket}`
        text = `🔔 「${sample.name}」已超时 ${overdue} 分钟，还没确认完成！`
      }

      // 本轮是否有人还没收到这个 key（全部收到则不重复发）
      const need = pending.filter(({ cycle }) => cycle.lastRemindKey !== key)
      if (!need.length) continue

      // 展示 id
      const idMap = new Map<number, number>()
      for (const { plan } of pending) idMap.set(plan.id, await displayId(plan))

      // 撤回旧提醒（同一条消息可能同时提醒了多人，按 message id 去重）
      if (recallOld) {
        const oldIds = new Set<string>()
        for (const { cycle } of pending) {
          if (cycle.lastRemindMsgId) oldIds.add(cycle.lastRemindMsgId)
        }
        for (const mid of oldIds) await recallMessage(sample.scope, mid)
      }

      // 发送（提醒所有仍在等待的成员）
      const sent = await sendToChannel(sample.scope, [
        h.text(text + '\n'),
        ...pending.flatMap(({ plan }) => [
          h('at', { id: plan.userId }),
          h.text(` (#${idMap.get(plan.id)}) `),
        ]),
        h.text(`\n完成后回复：plan done ${pending.map(({ plan }) => idMap.get(plan.id)).join(' ')}`),
      ])
      if (!sent) continue

      // 标记（记录本轮 key 与新消息 id，供下次撤回）
      const newId = sent[0] ?? ''
      for (const { cycle } of pending) {
        await ctx.database.set('daily_plan_cycle', { id: cycle.id }, {
          lastRemindKey: key,
          lastRemindMsgId: newId,
        })
      }
    }

  }

  // ── 展示 id：每个 scope+userId 内按 createdAt 排序的序号 ──
  const displayIdCache = new Map<number, number>()

  async function refreshDisplayIds(scope: string, userId: string): Promise<PlanRow[]> {
    const rows = (await ctx.database.get('daily_plan', { scope, userId }) as PlanRow[])
      .sort((a, b) => a.id - b.id)
    displayIdCache.clear()
    rows.forEach((r, i) => displayIdCache.set(r.id, i + 1))
    return rows
  }

  async function displayId(plan: PlanRow): Promise<number> {
    await refreshDisplayIds(plan.scope, plan.userId)
    return displayIdCache.get(plan.id) ?? 0
  }

  // 兼容旧数据：给「今天新建但还没定生效日」的计划补上 effectiveDate
  async function backfillEffectiveDates() {
    const now = new Date()
    const rows = await ctx.database.get('daily_plan', {}) as PlanRow[]
    for (const p of rows) {
      if (p.effectiveDate) continue
      if (!p.createdAt) continue
      if (todayStr(new Date(p.createdAt)) !== todayStr(now)) continue
      await ctx.database.set('daily_plan', { id: p.id }, { effectiveDate: firstCycleDate(p, now) })
    }
  }

  backfillEffectiveDates().catch((e) => logger.warn('backfill effectiveDate failed:', e?.message ?? e))

  ctx.cron('* * * * *', () => checkAndRemind(new Date()))

  // 便于测试/手动触发（不影响生产）
  ;(ctx as any).dailyPlanCheck = checkAndRemind
  ;((ctx as any).root ?? ctx)['dailyPlanCheck'] = checkAndRemind

  function extractMentions(session: Session): string[] {
    const ids: string[] = []
    for (const el of session.elements ?? []) {
      if (el.type === 'at' && el.attrs?.id && el.attrs.id !== session.selfId) {
        ids.push(String(el.attrs.id))
      }
    }
    return ids
  }

  ctx.command('plan <action> [...rest]', 'Daily plan management')
    .usage(
      'plan add <name> <HH:mm> [durationMin] [@user ...]\n' +
      '  e.g. plan add 背单词 15:00 120   (15:00 start, must finish within 120 min)\n' +
      'plan list / plan mine / plan del <id> / plan done <id>\n' +
      'plan time <id> <HH:mm> [durationMin]\n' +
      'plan snooze [id] <minutes>   (0 = resume)'
    )
    .action(async ({ session }, actionRaw, ...rest) => {
      const cmd = toHalfWidth((actionRaw || '').trim()).toLowerCase()
      const scope = session.guildId ? `${session.platform}:${session.guildId}`
        : (session.channelId ? `${session.platform}:${session.channelId}` : '')
      const me = session.userId ?? ''
      const usage = 'Usage:\n  plan add <name> <HH:mm> [分钟] [@user ...]\n  plan list | mine | del <id> | done <id> | time <id> <HH:mm> [分钟]\n  plan snooze [id] <minutes>  (0 = resume)'

      if (!cmd) return usage

      // ── add ──
      if (cmd === 'add') {
        const name = toHalfWidth(rest[0] || '').trim()
        const t = parseStartTime(rest[1] || '')
        if (!name || !t) return 'Usage: plan add <name> <HH:mm> [分钟] [@user ...]\nExample: plan add 背单词 15:00 120'
        const durRaw = rest[2] ? +toHalfWidth(rest[2]) : defaultDuration
        const durationMin = Number.isFinite(durRaw) && durRaw > 0 ? durRaw : defaultDuration
        const startTime = fmtTime(t.h, t.m)
        const effectiveDate = firstCycleDate({ startTime }, new Date())

        const mentioned = extractMentions(session)
        const targets = mentioned.length ? mentioned : [me]

        const existing = await ctx.database.get('daily_plan', { scope, name }) as PlanRow[]
        const conflicts = existing.filter((e) => targets.includes(e.userId))
        if (conflicts.length) {
          return `❌ 已有同名计划。每人同名计划只能一个，请换名字或用 plan time 改。`
        }

        const created: string[] = []
        for (const target of targets) {
          await ctx.database.create('daily_plan', {
            scope, userId: target, name, startTime,
            durationMin, enabled: 1, createdAt: new Date(),
            effectiveDate, snoozeUntil: null,
          })
          const rows = await refreshDisplayIds(scope, target)
          const row = rows[rows.length - 1]
          created.push(`#${displayIdCache.get(row.id)}`)
        }
        const who = mentioned.length ? mentioned.map((u) => `@${u}`).join(' ') : 'you'
        return `✅ 已添加「${name}」每天 ${startTime} 开始，${durationMin} 分钟内完成（${who}）\n首个周期：下一个 ${startTime}（${effectiveDate}）\nID: ${created.join(', ')}`
      }

      // ── list / mine ──
      if (cmd === 'list' || cmd === 'ls' || cmd === 'mine' || cmd === 'my') {
        const onlyMine = cmd === 'mine' || cmd === 'my'
        const rows = onlyMine
          ? await refreshDisplayIds(scope, me)
          : (await ctx.database.get('daily_plan', { scope }) as PlanRow[]).sort((a, b) => a.id - b.id)
        if (!rows.length) return onlyMine ? '📋 你还没有计划。' : '📋 本群暂无计划。'

        // 按属主分别建立 展示id 映射（每人独立编号）
        const idOf = new Map<number, number>()
        const byOwner = new Map<string, PlanRow[]>()
        for (const p of rows) {
          if (!byOwner.has(p.userId)) byOwner.set(p.userId, [])
          byOwner.get(p.userId)!.push(p)
        }
        for (const [, list] of byOwner) {
          list.sort((a, b) => a.id - b.id)
          list.forEach((p, i) => idOf.set(p.id, i + 1))
        }

        const now = new Date()
        const lines = [onlyMine ? '📋 我的每日计划：' : '📋 本群每日计划：']
        for (const p of rows) {
          const id = idOf.get(p.id) ?? '?'
          const cd = todayStr(cycleStart(p, now))
          let mark: string
          if (p.effectiveDate && cd < p.effectiveDate) {
            mark = '🕗'
          } else {
            const c = await getCycle(p, cd)
            mark = c?.done ? '✅' : (c?.failed ? '❌失败' : '⏳')
          }
          const snooze = isSnoozed(p, now)
            ? ` 🔕至${fmtTime(new Date(p.snoozeUntil!).getHours(), new Date(p.snoozeUntil!).getMinutes())}`
            : ''
          const mine = p.userId === me ? '（你）' : `（@${p.userId}）`
          lines.push(`#${id} ${p.name} ${p.startTime} 起 ${p.durationMin}分钟 ${mark}${snooze} ${mine}`)
        }
        return lines.join('\n')
      }

      // ── del ──
      if (cmd === 'del' || cmd === 'rm' || cmd === 'delete') {
        const wantId = +toHalfWidth(rest[0] || '')
        if (!wantId) return 'Usage: plan del <id>'
        const mine = await refreshDisplayIds(scope, me)
        const target = mine.find((p) => displayIdCache.get(p.id) === wantId)
        if (!target) return `❌ 没找到你的 #${wantId} 计划`
        await ctx.database.remove('daily_plan_cycle', { planId: target.id })
        await ctx.database.remove('daily_plan', { id: target.id })
        return `🗑️ 已删除「${target.name}」`
      }

      // ── done ──
      if (cmd === 'done') {
        const wantId = +toHalfWidth(rest[0] || '')
        if (!wantId) return 'Usage: plan done <id>'
        const mine = await refreshDisplayIds(scope, me)
        const target = mine.find((p) => displayIdCache.get(p.id) === wantId)
        if (!target) return `❌ 没找到你的 #${wantId} 计划`

        const now = new Date()
        const cd = todayStr(cycleStart(target, now))
        if (target.effectiveDate && cd < target.effectiveDate) {
          return `「${target.name}」还没开始（${target.effectiveDate} 起生效），无法确认完成。`
        }
        const c = await ensureCycle(target, cd)

        if (c.done) {
          // 今天已完成 → 二次确认是否提前完成下一轮
          const tomorrow = new Date(cycleStart(target, now))
          tomorrow.setDate(tomorrow.getDate() + 1)
          const td = todayStr(tomorrow)
          if (target.effectiveDate && td < target.effectiveDate) {
            return `「${target.name}」今天已完成 ✅`
          }
          const next = await ensureCycle(target, td)
          if (next.done) return `「${target.name}」今天和明天都已完成 ✅`
          if (!rest[1] || !['yes', 'confirm'].includes(toHalfWidth(rest[1]).toLowerCase())) {
            return `「${target.name}」今天已完成 ✅\n要提前完成下一轮吗？回复：plan done ${wantId} yes`
          }
          await ctx.database.set('daily_plan_cycle', { id: next.id }, { done: 1, doneAt: new Date() })
          return `✅ 已提前完成下一轮「${target.name}」（${tomorrow.getDate()}日）`
        }

        await ctx.database.set('daily_plan_cycle', { id: c.id }, { done: 1, doneAt: new Date() })
        return `✅ 已确认「${target.name}」完成（本轮 ${cd}）`
      }

      // ── time ──
      if (cmd === 'time' || cmd === 'settime') {
        const wantId = +toHalfWidth(rest[0] || '')
        const t = parseStartTime(rest[1] || '')
        if (!wantId || !t) return 'Usage: plan time <id> <HH:mm> [分钟]'
        const mine = await refreshDisplayIds(scope, me)
        const target = mine.find((p) => displayIdCache.get(p.id) === wantId)
        if (!target) return `❌ 没找到你的 #${wantId} 计划`
        const durRaw = rest[2] ? +toHalfWidth(rest[2]) : target.durationMin
        const durationMin = Number.isFinite(durRaw) && durRaw > 0 ? durRaw : target.durationMin
        const startTime = fmtTime(t.h, t.m)
        const effectiveDate = firstCycleDate({ startTime }, new Date())
        await ctx.database.set('daily_plan', { id: target.id }, {
          startTime, durationMin, effectiveDate,
        })
        return `🕐 「${target.name}」改为每天 ${startTime} 开始，${durationMin} 分钟内完成。`
      }

      // ── snooze / mute ──
      if (cmd === 'snooze' || cmd === 'mute' || cmd === 'quiet') {
        let onlyId: number | null = null
        let minutes = defaultSnooze
        if (rest.length >= 2) {
          onlyId = +toHalfWidth(rest[0])
          minutes = +toHalfWidth(rest[1])
        } else if (rest.length === 1) {
          minutes = +toHalfWidth(rest[0])
        }
        if (!Number.isFinite(minutes) || minutes < 0 || (onlyId !== null && !Number.isFinite(onlyId))) {
          return 'Usage: plan snooze [id] <minutes>  (0 = resume)'
        }
        const mine = await refreshDisplayIds(scope, me)
        const targets = onlyId !== null ? mine.filter((p) => displayIdCache.get(p.id) === onlyId) : mine
        if (onlyId !== null && !targets.length) return `❌ 没找到你的 #${onlyId} 计划`
        if (!targets.length) return '📋 你还没有计划。'
        const until = minutes > 0 ? new Date(Date.now() + minutes * 60000) : null
        for (const p of targets) {
          await ctx.database.set('daily_plan', { id: p.id }, { snoozeUntil: until })
        }
        if (!until) return '🔔 已恢复提醒。'
        if (targets.length > 1) {
          return `🔕 已静音 ${targets.length} 个计划 ${minutes} 分钟（至 ${fmtTime(until.getHours(), until.getMinutes())}）`
        }
        return `🔕 已静音「${targets[0].name}」 ${minutes} 分钟（至 ${fmtTime(until.getHours(), until.getMinutes())}）`
      }

      return `Unknown command: ${cmd}\n\n${usage}`
    })
}
