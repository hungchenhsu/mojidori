// Exact English keys consumed by CodeMirror search/fold UI and screen-reader
// announcements. Keep this data module independent of CodeMirror imports;
// editor.ts applies it through EditorState.phrases and its locale compartment.
//
// The last four keys are this app's own (editor.ts's search match counter),
// not upstream CodeMirror strings; `$1`/`$2` are EditorState.phrase's
// positional insertions, so the English key text doubles as the English
// rendering.
import type { Locale } from "./i18n";

const CM6_PHRASES_ZH_TW = {
  Find: "尋找",
  Replace: "取代",
  next: "下一個",
  previous: "上一個",
  all: "全部",
  "match case": "區分大小寫",
  regexp: "正規表示式",
  "by word": "全字符合",
  replace: "取代",
  "replace all": "全部取代",
  close: "關閉",
  "Go to line": "跳至行號",
  go: "前往",
  "replaced match on line $": "已在第 $ 行取代符合項目",
  "replaced $ matches": "已取代 $ 筆符合項目",
  "current match": "目前符合項目",
  "on line": "位於行",
  "Fold line": "摺疊此行",
  "Unfold line": "展開此行",
  "folded code": "已摺疊的程式碼",
  unfold: "展開",
  "Folded lines": "已摺疊行",
  "Unfolded lines": "已展開行",
  to: "至",
  "$1 of $2": "第 $1 / $2 筆",
  "$ matches": "$ 筆符合",
  "1 match": "1 筆符合",
  "No matches": "無符合項目",
} as const;

type PhraseKey = keyof typeof CM6_PHRASES_ZH_TW;

const CM6_PHRASES: Record<Exclude<Locale, "en">, Record<PhraseKey, string>> = {
  "zh-TW": CM6_PHRASES_ZH_TW,
  ja: {
    Find: "検索",
    Replace: "置換",
    next: "次へ",
    previous: "前へ",
    all: "すべて",
    "match case": "大文字と小文字を区別",
    regexp: "正規表現",
    "by word": "単語単位",
    replace: "置換",
    "replace all": "すべて置換",
    close: "閉じる",
    "Go to line": "行へ移動",
    go: "移動",
    "replaced match on line $": "$ 行目の一致を置換しました",
    "replaced $ matches": "$ 件を置換しました",
    "current match": "現在の一致",
    "on line": "行",
    "Fold line": "行を折りたたむ",
    "Unfold line": "行を展開",
    "folded code": "折りたたまれたコード",
    unfold: "展開",
    "Folded lines": "折りたたんだ行",
    "Unfolded lines": "展開した行",
    to: "から",
    "$1 of $2": "$2 件中 $1 件目",
    "$ matches": "$ 件一致",
    "1 match": "1 件一致",
    "No matches": "一致なし",
  },
  "zh-CN": {
    Find: "查找",
    Replace: "替换",
    next: "下一个",
    previous: "上一个",
    all: "全部",
    "match case": "区分大小写",
    regexp: "正则表达式",
    "by word": "全字匹配",
    replace: "替换",
    "replace all": "全部替换",
    close: "关闭",
    "Go to line": "跳转到行",
    go: "前往",
    "replaced match on line $": "已在第 $ 行替换匹配项",
    "replaced $ matches": "已替换 $ 个匹配项",
    "current match": "当前匹配项",
    "on line": "位于行",
    "Fold line": "折叠此行",
    "Unfold line": "展开此行",
    "folded code": "已折叠的代码",
    unfold: "展开",
    "Folded lines": "已折叠行",
    "Unfolded lines": "已展开行",
    to: "至",
    "$1 of $2": "第 $1 / $2 项",
    "$ matches": "$ 个匹配项",
    "1 match": "1 个匹配项",
    "No matches": "无匹配项",
  },
};

// English otherwise uses CodeMirror's own keys verbatim; only the search
// panel's lowercase button/checkbox labels are capitalized to match the rest
// of the app's sentence-case UI.
const CM6_PHRASES_EN: Partial<Record<PhraseKey, string>> = {
  next: "Next",
  previous: "Previous",
  all: "All",
  "match case": "Match case",
  regexp: "Regexp",
  "by word": "By word",
  replace: "Replace",
  "replace all": "Replace all",
  go: "Go",
};

export function cm6Phrases(locale: Locale): Record<string, string> {
  return locale === "en" ? CM6_PHRASES_EN : CM6_PHRASES[locale];
}
