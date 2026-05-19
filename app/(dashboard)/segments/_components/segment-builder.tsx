"use client";

/**
 * 分群条件树可视化构建器。
 *
 * 设计要点：
 *  - 状态由父组件持有（受控）：value: SegmentCondition；onChange: (next) => void
 *  - 节点 key 使用「路径数组」表达，避免引入额外 id 字段污染输出 JSON
 *  - 字段 → 允许算子映射、value 形态全部从 lib/modules/segment/conditions.ts 复用，与后端校验同源
 *  - 仅做编辑；validate（深度/叶子上限）与命中数预览交给父页面（POST /api/segments/validate）
 */

import { useId, useMemo } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { swrFetcher } from "@/lib/api-client";
import {
  SEGMENT_FIELDS,
  SEGMENT_FIELD_OPERATORS,
  isGroupCondition,
  type GroupCondition,
  type LeafCondition,
  type SegmentCondition,
  type SegmentField,
  type SegmentOperator,
} from "@/lib/modules/segment/conditions";

const FIELD_LABEL: Record<SegmentField, string> = {
  userLevel: "用户等级",
  source: "导入来源",
  totalSpend: "累计消费",
  orderCount: "订单数",
  engagementScore: "参与度评分",
  totalBounceCount: "硬退信次数",
  totalOpens: "总打开次数",
  totalClicks: "总点击次数",
  lastOrderAt: "最近下单时间",
  createdAt: "用户创建时间",
  unsubscribed: "是否退订",
  tags: "标签",
  lastOpenedWithinDays: "最近 N 天内打开",
  lastClickedWithinDays: "最近 N 天内点击",
  emailSentWithinDays: "最近 N 天内收到",
};

const OPERATOR_LABEL: Record<SegmentOperator, string> = {
  eq: "等于",
  neq: "不等于",
  gt: "大于",
  gte: "大于等于",
  lt: "小于",
  lte: "小于等于",
  in: "属于（多选）",
  notIn: "不属于",
  contains: "包含",
  between: "介于",
  within_days: "最近 N 天内",
  has_tag: "拥有标签",
  not_has_tag: "不含标签",
};

const STRING_FIELDS = ["userLevel", "source"] as const;
const NUMBER_FIELDS = [
  "totalSpend",
  "orderCount",
  "engagementScore",
  "totalBounceCount",
  "totalOpens",
  "totalClicks",
] as const;
const DATETIME_FIELDS = ["lastOrderAt", "createdAt"] as const;
const BEHAVIOR_FIELDS = [
  "lastOpenedWithinDays",
  "lastClickedWithinDays",
  "emailSentWithinDays",
] as const;

function fieldKind(field: SegmentField):
  | "string"
  | "number"
  | "datetime"
  | "boolean"
  | "tag"
  | "behavior" {
  if ((STRING_FIELDS as readonly string[]).includes(field)) return "string";
  if ((NUMBER_FIELDS as readonly string[]).includes(field)) return "number";
  if ((DATETIME_FIELDS as readonly string[]).includes(field)) return "datetime";
  if ((BEHAVIOR_FIELDS as readonly string[]).includes(field)) return "behavior";
  if (field === "unsubscribed") return "boolean";
  if (field === "tags") return "tag";
  return "string";
}

function defaultLeaf(): LeafCondition {
  return { field: "userLevel", operator: "eq", value: "" };
}

function defaultGroup(): GroupCondition {
  return { logic: "AND", conditions: [defaultLeaf()] };
}

export const EMPTY_SEGMENT_TREE: GroupCondition = {
  logic: "AND",
  conditions: [defaultLeaf()],
};

/** 安全 setter：根据「path 路径」更新条件树中的某个节点。 */
function updateAt(
  tree: SegmentCondition,
  path: number[],
  updater: (n: SegmentCondition) => SegmentCondition,
): SegmentCondition {
  if (path.length === 0) return updater(tree);
  if (!isGroupCondition(tree)) return tree;
  const [head, ...rest] = path;
  return {
    ...tree,
    conditions: tree.conditions.map((c, i) =>
      i === head ? updateAt(c, rest, updater) : c,
    ),
  };
}

function removeAt(tree: SegmentCondition, path: number[]): SegmentCondition {
  if (path.length === 0) return tree;
  if (!isGroupCondition(tree)) return tree;
  const [head, ...rest] = path;
  if (rest.length === 0) {
    const next = tree.conditions.filter((_, i) => i !== head);
    return {
      ...tree,
      conditions: next.length > 0 ? next : [defaultLeaf()],
    };
  }
  return {
    ...tree,
    conditions: tree.conditions.map((c, i) =>
      i === head ? removeAt(c, rest) : c,
    ),
  };
}

export interface SegmentBuilderProps {
  value: SegmentCondition;
  onChange: (next: SegmentCondition) => void;
  /** 顶层最大嵌套深度，默认 5（与后端一致） */
  maxDepth?: number;
}

export default function SegmentBuilder({
  value,
  onChange,
  maxDepth = 5,
}: SegmentBuilderProps) {
  const root = useMemo<GroupCondition>(() => {
    return isGroupCondition(value) ? value : { logic: "AND", conditions: [value] };
  }, [value]);

  /**
   * 标签自动补全：一次性拉前 200 个标签，注入到 <datalist> 中供
   * has_tag / not_has_tag 输入框引用。`useId()` 保证多个 builder 共存时
   * datalist id 不冲突。
   */
  const tagListId = useId();
  const { data: tagsResp } = useSWR<{ data: { id: string; name: string }[] }>(
    "/api/tags?pageSize=200",
    swrFetcher,
  );
  const tagSuggestions = useMemo(
    () => (tagsResp?.data ?? []).map((t) => t.name),
    [tagsResp],
  );

  function setRoot(updater: (n: SegmentCondition) => SegmentCondition) {
    const next = updater(root);
    onChange(next);
  }

  return (
    <div className="space-y-3" data-testid="segment-builder">
      <datalist id={tagListId}>
        {tagSuggestions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <GroupNode
        node={root}
        path={[]}
        depth={1}
        maxDepth={maxDepth}
        tagListId={tagListId}
        onUpdate={(p, u) => setRoot((t) => updateAt(t, p, u))}
        onRemove={(p) => setRoot((t) => removeAt(t, p))}
      />
    </div>
  );
}

function GroupNode({
  node,
  path,
  depth,
  maxDepth,
  tagListId,
  onUpdate,
  onRemove,
}: {
  node: GroupCondition;
  path: number[];
  depth: number;
  maxDepth: number;
  tagListId: string;
  onUpdate: (p: number[], u: (n: SegmentCondition) => SegmentCondition) => void;
  onRemove: (p: number[]) => void;
}) {
  const isRoot = path.length === 0;
  const canNest = depth < maxDepth;

  return (
    <div
      className="space-y-2 rounded-md border bg-card p-3"
      data-testid={`segment-group-${path.join("-") || "root"}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">逻辑</span>
        <select
          value={node.logic}
          onChange={(e) =>
            onUpdate(path, (n) => {
              if (!isGroupCondition(n)) return n;
              return { ...n, logic: e.target.value as "AND" | "OR" };
            })
          }
          className="h-8 rounded-md border bg-background px-2 text-sm"
          data-testid={`segment-logic-${path.join("-") || "root"}`}
        >
          <option value="AND">AND（全部满足）</option>
          <option value="OR">OR（任一满足）</option>
        </select>
        <span className="text-xs text-muted-foreground">
          层级 {depth} / {maxDepth}
        </span>
        {!isRoot ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onRemove(path)}
          >
            移除组
          </Button>
        ) : null}
      </div>

      <div className="space-y-2 pl-3">
        {node.conditions.map((child, i) => {
          const childPath = [...path, i];
          if (isGroupCondition(child)) {
            return (
              <GroupNode
                key={i}
                node={child}
                path={childPath}
                depth={depth + 1}
                maxDepth={maxDepth}
                tagListId={tagListId}
                onUpdate={onUpdate}
                onRemove={onRemove}
              />
            );
          }
          return (
            <LeafNode
              key={i}
              node={child}
              path={childPath}
              tagListId={tagListId}
              onUpdate={onUpdate}
              onRemove={onRemove}
            />
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            onUpdate(path, (n) => {
              if (!isGroupCondition(n)) return n;
              return { ...n, conditions: [...n.conditions, defaultLeaf()] };
            })
          }
          data-testid={`segment-add-leaf-${path.join("-") || "root"}`}
        >
          + 添加条件
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canNest}
          title={canNest ? undefined : `已达最大嵌套深度 ${maxDepth}`}
          onClick={() =>
            onUpdate(path, (n) => {
              if (!isGroupCondition(n)) return n;
              return { ...n, conditions: [...n.conditions, defaultGroup()] };
            })
          }
          data-testid={`segment-add-group-${path.join("-") || "root"}`}
        >
          + 添加条件组
        </Button>
      </div>
    </div>
  );
}

function LeafNode({
  node,
  path,
  tagListId,
  onUpdate,
  onRemove,
}: {
  node: LeafCondition;
  path: number[];
  tagListId: string;
  onUpdate: (p: number[], u: (n: SegmentCondition) => SegmentCondition) => void;
  onRemove: (p: number[]) => void;
}) {
  const allowedOps = SEGMENT_FIELD_OPERATORS[node.field];
  const operator = allowedOps.includes(node.operator) ? node.operator : allowedOps[0];

  function setLeaf(patch: Partial<LeafCondition>) {
    onUpdate(path, (n) => {
      if (isGroupCondition(n)) return n;
      return { ...n, ...patch };
    });
  }

  function setField(field: SegmentField) {
    const ops = SEGMENT_FIELD_OPERATORS[field];
    const op = ops[0];
    setLeaf({ field, operator: op, value: defaultValueFor(field, op) });
  }

  function setOperator(op: SegmentOperator) {
    setLeaf({ operator: op, value: defaultValueFor(node.field, op) });
  }

  return (
    <div
      className="flex flex-wrap items-start gap-2 rounded-md border bg-background p-2"
      data-testid={`segment-leaf-${path.join("-")}`}
    >
      <select
        value={node.field}
        onChange={(e) => setField(e.target.value as SegmentField)}
        className="h-8 rounded-md border bg-background px-2 text-sm"
        aria-label="字段"
      >
        {SEGMENT_FIELDS.map((f) => (
          <option key={f} value={f}>
            {FIELD_LABEL[f]}
          </option>
        ))}
      </select>

      <select
        value={operator}
        onChange={(e) => setOperator(e.target.value as SegmentOperator)}
        className="h-8 rounded-md border bg-background px-2 text-sm"
        aria-label="算子"
      >
        {allowedOps.map((op) => (
          <option key={op} value={op}>
            {OPERATOR_LABEL[op]}
          </option>
        ))}
      </select>

      <ValueInput
        field={node.field}
        operator={operator}
        value={node.value}
        tagListId={tagListId}
        onChange={(v) => setLeaf({ value: v })}
      />

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="ml-auto"
        onClick={() => onRemove(path)}
      >
        移除
      </Button>
    </div>
  );
}

function defaultValueFor(field: SegmentField, op: SegmentOperator): unknown {
  const kind = fieldKind(field);
  if (op === "between") {
    return kind === "datetime" ? ["", ""] : [0, 0];
  }
  if (op === "in" || op === "notIn") return [];
  if (op === "within_days") return 7;
  if (op === "has_tag" || op === "not_has_tag") return "";
  if (kind === "boolean") return true;
  if (kind === "number") return 0;
  if (kind === "behavior") return 7;
  if (kind === "datetime") return "";
  return "";
}

function ValueInput({
  field,
  operator,
  value,
  tagListId,
  onChange,
}: {
  field: SegmentField;
  operator: SegmentOperator;
  value: unknown;
  tagListId: string;
  onChange: (v: unknown) => void;
}) {
  const kind = fieldKind(field);

  if (operator === "between") {
    const arr = Array.isArray(value) ? value : ["", ""];
    const [a, b] = [arr[0], arr[1]];
    const inputType = kind === "datetime" ? "datetime-local" : "number";
    return (
      <div className="flex items-center gap-1">
        <Input
          type={inputType}
          value={a == null ? "" : String(a)}
          onChange={(e) => {
            const v =
              inputType === "number" ? Number(e.target.value) : e.target.value;
            onChange([v, b]);
          }}
          className="h-8 w-40"
        />
        <span className="text-xs text-muted-foreground">~</span>
        <Input
          type={inputType}
          value={b == null ? "" : String(b)}
          onChange={(e) => {
            const v =
              inputType === "number" ? Number(e.target.value) : e.target.value;
            onChange([a, v]);
          }}
          className="h-8 w-40"
        />
      </div>
    );
  }

  if (operator === "in" || operator === "notIn") {
    const arr = Array.isArray(value) ? (value as string[]) : [];
    return (
      <Input
        value={arr.join(",")}
        placeholder="逗号分隔，如 vip,pro"
        onChange={(e) => {
          const list = e.target.value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          onChange(list);
        }}
        className="h-8 w-64"
      />
    );
  }

  if (operator === "within_days" || kind === "behavior") {
    return (
      <Input
        type="number"
        min={1}
        max={3650}
        value={typeof value === "number" ? value : ""}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-8 w-32"
        placeholder="天数"
      />
    );
  }

  if (operator === "has_tag" || operator === "not_has_tag") {
    return (
      <Input
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-48"
        placeholder="标签名称"
        list={tagListId}
        autoComplete="off"
      />
    );
  }

  if (kind === "boolean") {
    return (
      <select
        value={value === true ? "true" : "false"}
        onChange={(e) => onChange(e.target.value === "true")}
        className="h-8 rounded-md border bg-background px-2 text-sm"
        aria-label="布尔值"
      >
        <option value="true">是</option>
        <option value="false">否</option>
      </select>
    );
  }

  if (kind === "number") {
    return (
      <Input
        type="number"
        value={typeof value === "number" ? value : ""}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-8 w-40"
      />
    );
  }

  if (kind === "datetime") {
    return (
      <Input
        type="datetime-local"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-52"
      />
    );
  }

  return (
    <Input
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-64"
      placeholder="文本值"
    />
  );
}
