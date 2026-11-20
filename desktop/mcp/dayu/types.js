/**
 * 配置 schema 类型：rules.yaml / platforms.yaml 的编译期契约。
 * 让配置错误在进入工具层之前暴露，而不是散落成运行时的 undefined。
 * 说明：YAML 顶层字段可选（兼容外部语言包只覆盖部分字段），由 ruleConsistency() 做"必填且合法"的强校验。
 */
export {};
