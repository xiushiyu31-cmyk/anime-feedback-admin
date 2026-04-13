type OutCategory =
  | "现有破次元功能优化"
  | "破次元新功能需求"
  | "软件非破次元功能需求"
  | "用户其他反馈";

const POCIYUAN_NEW_KEYWORDS = [
  "祛鼻贴", "去鼻贴", "鼻贴",
  "祛底裤", "去底裤", "去打底裤", "祛打底裤", "底裤",
  "祛腿毛", "去腿毛", "腿毛",
  "头发反重力", "反重力", "动画头发", "头发动态",
  "发丝发光", "眼睛发光", "武器发光",
  "辉光", "打光特效", "打光",
  "粒子特效", "羽毛特效", "火焰特效", "雷电特效", "樱花特效", "雪花特效",
  "碎石", "烟雾",
  "文字指令", "一句话生成", "AI生成修图", "指令生成", "生成式修图",
  "AI布景", "AI自定义",
  "背景净化", "暗调",
  "裙摆扩大", "裙摆",
  "衣物反重力", "衣物平整", "去衣褶",
  "漫画脸",
  "cos特效", "cosplay特效",
  "武器素材",
  "二次元风格", "二次元发型", "二次元美瞳",
  "自定义美瞳", "美瞳色号", "美瞳",
  "增加乳沟", "乳沟",
  "去脸部贴纸", "脸部贴纸",
  "天空替换", "背景替换",
  "自定义效果", "自定义上传素材",
  "画头发", "头发光",
];

const POCIYUAN_OPTIMIZE_KEYWORDS = [
  "亮度对比度", "亮度加深", "对比度加深",
];

const POCIYUAN_REGEX_PATTERNS = [
  /祛/,
  /去(?!年|月|日).*?(?:毛|裤|贴|纸)/,
  /特效/,
  /素材/,
  /辉光/,
  /粒子/,
  /打光/,
  /动画/,
  /发光/,
  /反重力/,
  /美瞳/,
  /(?:二次元|cos).*?发型/,
  /生成式修图/,
];

const NON_POCIYUAN_KEYWORDS = [
  "付费", "会员", "价格", "收费", "扣费",
  "卡顿", "崩溃", "闪退", "性能",
  "快捷键", "导入导出", "镜头矫正",
  "跨端", "同步", "创意板块",
  "设备兼容", "安装",
];

/**
 * AI 返回分类结果后，用关键词硬规则强制纠正明显的错误分类。
 * 解决 AI 模型不遵守 prompt 中分类指令的问题。
 */
export function forceCorrectCategory(
  essenceKey: string,
  originalText: string,
  aiCategory: string,
): string {
  const text = `${essenceKey} ${originalText}`.toLowerCase();

  if (aiCategory === "用户其他反馈" || aiCategory === "软件非破次元功能需求") {
    for (const kw of NON_POCIYUAN_KEYWORDS) {
      if (text.includes(kw)) return aiCategory;
    }

    for (const kw of POCIYUAN_NEW_KEYWORDS) {
      if (text.includes(kw.toLowerCase())) return "破次元新功能需求";
    }
    for (const kw of POCIYUAN_OPTIMIZE_KEYWORDS) {
      if (text.includes(kw.toLowerCase())) return "现有破次元功能优化";
    }
    for (const re of POCIYUAN_REGEX_PATTERNS) {
      if (re.test(text)) return "破次元新功能需求";
    }
  }

  return aiCategory;
}
