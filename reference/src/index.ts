/**
 * dsh-screeps host 插件入口（S5）。
 * class plugin：loader 取 default export，cordis 用 static Config 实例化并注册 'screeps' 服务。
 */
import { ScreepsService } from './host/service.ts'

export { ScreepsService } from './host/service.ts'
export type { Config, ScreepsServiceStatus, ScreepsWorldSnapshot } from './host/service.ts'
export { MatchService } from './host/match/match-service.ts'
export type { MatchObservation, SettleReason } from './host/match/lifecycle.ts'

export default ScreepsService
