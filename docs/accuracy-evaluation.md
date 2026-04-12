# 需求分析准确度评测

这套工具的目标是把“感觉 GPT 不太准”变成“知道哪里不准、错了多少、该怎么改”。

## 你要准备什么

先整理一份黄金测试集，建议先从 `100~300` 条开始。

模板文件在：

`templates/feedback-golden-set-template.csv`

建议列说明：

- `enabled`: 是否启用该样本，`true/false`
- `case_id`: 样本唯一 ID
- `expected_is_demand`: 这条消息是不是需求，`true/false`
- `source_group`: 来源群
- `source_sender`: 发送者
- `source_time`: 时间
- `note`: 用户原话
- `screenshot_path`: 本机截图绝对路径
- `expected_title`: 你认为正确的标题
- `expected_category`: 你认为正确的分类
- `expected_essence_key`: 你认为正确的需求本质
- `review_note`: 人工备注

## 标注建议

为了让后续准确度提升更快，建议样本尽量覆盖：

- 短句需求
- 长篇大论需求
- 多个需求混在一条消息里
- 纯闲聊
- 活动通知
- 功能咨询
- 二次元需求与非二次元需求边界样本
- 同义表达样本

## 先怎么用

1. 保证本地项目已启动在 `http://127.0.0.1:3001`
2. 把你的真实案例填进 CSV 或 XLSX
3. 运行评测命令

```bash
npm run eval:analyze -- templates/feedback-golden-set-template.csv
```

也可以换成你自己的文件：

```bash
npm run eval:analyze -- "/absolute/path/to/my-golden-set.xlsx"
```

## 当前脚本会评测什么

当前版本主要评测平台侧结构化分析能力，也就是：

- `title`
- `category`
- `essenceKey`

其中：

- `title` 用“软匹配”
- `category` 用“精确匹配”
- `essenceKey` 用“软匹配”

非需求样本目前会先跳过，后面我们再补“需求识别器”的专项评测。

## 跑完你会得到什么

脚本会输出：

- 标题软匹配准确率
- 分类精确准确率
- 本质词软匹配准确率
- 总体通过率
- 前 10 条失败样本

完整报告会写到：

`/.runtime/accuracy-eval/latest-report.json`

## 我建议的下一步

当你整理出第一批真实案例后，我们按这个顺序继续：

1. 跑第一轮基线准确率
2. 看失败样本
3. 调整 prompt / 分类词典 / 归并词表
4. 再跑第二轮
5. 把人工修正结果继续回灌进黄金测试集
