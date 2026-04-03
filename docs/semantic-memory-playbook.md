# engram 语义记忆与召回手册

> 对齐今日 Trending 项目中“记忆压缩”“语义检索”“跨会话上下文注入”三类最佳实践。

## 为什么光有存储还不够

记忆系统真正难的不是“记下来”，而是：

- 什么时候该记
- 记成什么结构
- 什么时候该压缩
- 下一轮该召回哪一段
- 怎样避免把无关旧信息持续注入

如果仓库已经增加了 semantic search adapter，这正好是把“存储”升级成“可检索记忆层”的关键一步。

## 推荐的记忆生命周期

### 1. Capture

只记录高价值信息：

- 用户偏好
- 长期目标
- 已验证事实
- 失败教训
- 可复用中间结果

### 2. Distill

把长文本压缩成结构化记忆项：

- summary
- keywords
- entities
- source
- importance
- expires_at

### 3. Index

对适合召回的内容建立向量索引，同时保留关键词和标签索引，避免只依赖 embedding。

### 4. Recall

召回时建议混合排序：

- 向量相似度
- 最近使用时间
- 重要性分数
- 来源可信度

### 5. Decay / Archive

不是所有记忆都该永远保留。建议引入：

- 访问衰减
- 时间衰减
- 被更新后归档旧版本

## OpenAI / Ollama 嵌入适配建议

如果项目同时支持 OpenAI 和 Ollama embedding，建议统一适配层返回：

- `embedding_model`
- `vector_dimension`
- `latency_ms`
- `token_usage`
- `provider`

这样后续更容易比较不同提供方的召回质量与成本。

## 召回失败的常见原因

- 写入时没有抽取关键词
- 只按相似度排序，忽略新鲜度
- 把瞬时对话也写成长期记忆
- 没有对相似记忆做合并
- 用户偏好被更新后旧版本仍高频召回

## 推荐评估指标

- recall@k
- irrelevant_hit_rate
- memory_freshness
- compression_ratio
- retrieval_latency

## 今日可继续补强的方向

- 增加 `docs/memory-lifecycle.md`
- 增加跨会话注入示例
- 增加记忆去重与冲突合并策略说明
- 增加 embedding provider 对比基准
