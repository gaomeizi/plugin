import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Select, message } from 'antd';
import jsMind from 'jsmind';
import 'jsmind/style/jsmind.css';
import { useBitable, RecordData, FieldInfo } from '../hooks/useBitable';
import './MindMapView.css';

/** 执行结果颜色映射（关键词匹配） */
const STATUS_COLOR_MAP: { keywords: string[]; bg: string; border: string; text: string }[] = [
  { keywords: ['通过', '成功', 'pass', 'passed'], bg: '#f6ffed', border: '#52c41a', text: '#237804' },
  { keywords: ['失败', 'fail', 'failed'], bg: '#fff1f0', border: '#ff4d4f', text: '#a8071a' },
  { keywords: ['阻塞', 'block', 'blocked'], bg: '#fffbe6', border: '#faad14', text: '#874d00' },
  { keywords: ['跳过', 'skip', 'skipped'], bg: '#f0f0f0', border: '#8c8c8c', text: '#595959' },
];

/**
 * 节点层级枚举
 * Level 1: 功能模块（无父记录的记录节点）
 * Level 2: 测试用例（有父记录的记录节点）
 * Level 3: 字段名节点（ID 格式: {recordId}_{fieldId}）
 * Level 4: 字段值节点（ID 格式: {recordId}_{fieldId}_val）
 */
enum NodeLevel {
  ROOT = 0,
  MODULE = 1,
  TESTCASE = 2,
  FIELD_NAME = 3,
  FIELD_VALUE = 4,
}

/**
 * 判断节点层级
 */
function getNodeLevel(
  nodeId: string,
  records: RecordData[],
  parentFieldId: string | undefined
): NodeLevel {
  if (nodeId === 'root') return NodeLevel.ROOT;

  // 字段值节点: {recordId}_{fieldId}_val
  if (nodeId.endsWith('_val')) return NodeLevel.FIELD_VALUE;

  // 字段名节点: {recordId}_{fieldId} — 不是记录 ID
  const isRecord = records.some((r) => r.id === nodeId);
  if (!isRecord) return NodeLevel.FIELD_NAME;

  // 记录节点：判断是否有父记录
  if (parentFieldId) {
    const record = records.find((r) => r.id === nodeId);
    if (record && record.fields[parentFieldId]) {
      return NodeLevel.TESTCASE; // 有父记录 → 第2层
    }
  }
  return NodeLevel.MODULE; // 无父记录 → 第1层
}

/**
 * 从节点 ID 解析出所属的 recordId
 * 节点 ID 格式:
 *   记录节点: recordId (如 recvkdzbLCTXUO)
 *   字段名节点: {recordId}_{fieldId}
 *   字段值节点: {recordId}_{fieldId}_val
 * 通过遍历 records 找到匹配的前缀
 */
function resolveRecordId(nodeId: string, records: RecordData[]): string | null {
  // 直接是记录节点
  if (records.some((r) => r.id === nodeId)) return nodeId;

  // 尝试从前缀匹配
  for (const r of records) {
    if (nodeId.startsWith(r.id + '_')) {
      return r.id;
    }
  }
  return null;
}

/**
 * 从字段值节点 ID 中提取 fieldId
 * 节点 ID 格式: {recordId}_{fieldId}_val 或 {recordId}_{fieldId}
 */
function resolveFieldId(nodeId: string, recordId: string): string | null {
  const suffix = nodeId.slice(recordId.length + 1); // 去掉 recordId_
  if (suffix.endsWith('_val')) {
    return suffix.slice(0, -4); // 去掉 _val
  }
  return suffix || null;
}

/**
 * 根据执行结果值获取颜色配置
 */
function getStatusColor(value: string) {
  if (!value) return null;
  const lower = value.toLowerCase();
  return STATUS_COLOR_MAP.find((c) => c.keywords.some((k) => lower.includes(k))) || null;
}

/**
 * 将飞书表格数据转换为 jsMind 数据格式
 */
function buildJsMindData(
  records: RecordData[],
  labelFieldId: string,
  parentFieldId: string | undefined,
  childFieldIds: string[],
  fieldList: FieldInfo[],
  statusFieldId?: string
) {
  if (records.length === 0 || !labelFieldId) {
    return { id: 'root', topic: '空数据', children: [] };
  }

  const nameToIds = new Map<string, string[]>();
  records.forEach((r) => {
    const name = r.fields[labelFieldId] || '';
    if (name) {
      const ids = nameToIds.get(name) || [];
      ids.push(r.id);
      nameToIds.set(name, ids);
    }
  });

  const childrenMap = new Map<string, string[]>();
  const hasParent = new Set<string>();

  if (parentFieldId) {
    records.forEach((r) => {
      const parentValue = r.fields[parentFieldId];
      if (!parentValue) return;
      const parentIds = nameToIds.get(parentValue) || [];
      const parentId = parentIds.find((pid) => pid !== r.id);
      if (parentId) {
        const children = childrenMap.get(parentId) || [];
        children.push(r.id);
        childrenMap.set(parentId, children);
        hasParent.add(r.id);
      }
    });
  }

  const fieldNameMap = new Map(fieldList.map((f) => [f.id, f.name]));
  const recordMap = new Map(records.map((r) => [r.id, r]));

  function buildNode(recordId: string): any {
    const record = recordMap.get(recordId)!;
    const label = record.fields[labelFieldId] || recordId.slice(0, 8);
    const children: any[] = [];

    const childRecordIds = childrenMap.get(recordId) || [];
    childRecordIds.forEach((childId) => {
      children.push(buildNode(childId));
    });

    // 只有叶子记录（没有子记录的节点）才展开字段
    const isLeafRecord = childRecordIds.length === 0;
    if (isLeafRecord && hasParent.has(recordId) && childFieldIds.length > 0) {
      const fieldsToShow = childFieldIds.filter(
        (fid) => fid !== labelFieldId && fid !== parentFieldId
      );
      fieldsToShow.forEach((fieldId) => {
        const fieldName = fieldNameMap.get(fieldId) || fieldId;
        const value = record.fields[fieldId] || '';
        children.push({
          id: `${recordId}_${fieldId}`,
          topic: fieldName,
          children: [{
            id: `${recordId}_${fieldId}_val`,
            topic: value || '(空)',
            children: [],
          }],
        });
      });
    }

    // 获取执行结果颜色（叶子用例节点才染色）
    const statusValue = statusFieldId ? (record.fields[statusFieldId] || '') : '';
    const color = getStatusColor(statusValue);

    return {
      id: recordId,
      topic: label,
      children,
      // 把颜色信息存在 data 里，渲染后通过 DOM 操作应用
      'data-status': statusValue,
      'data-bg': color?.bg || '',
      'data-border': color?.border || '',
    };
  }

  const rootIds = records.filter((r) => !hasParent.has(r.id)).map((r) => r.id);

  if (rootIds.length === 1) {
    return buildNode(rootIds[0]);
  }

  return {
    id: 'root',
    topic: '测试用例',
    children: rootIds.map((id) => buildNode(id)),
  };
}

export const MindMapView: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const jmRef = useRef<any>(null);
  const { records, fieldList, loading, error, refresh, addRecord, updateField, deleteRecord } = useBitable();

  const [parentFieldId, setParentFieldId] = useState<string>('');
  const [childFieldIds, setChildFieldIds] = useState<string[]>([]);

  // labelFieldId 始终是第一列，不需要用户选择
  const effectiveLabelFieldId = fieldList.length > 0 ? fieldList[0].id : '';
  const [statusFieldId, setStatusFieldId] = useState<string>('');
  const [statusOptions, setStatusOptions] = useState<string[]>([]);
  /** 所有单选字段及其选项，用于标记操作 */
  const [selectFields, setSelectFields] = useState<{ id: string; name: string; options: string[] }[]>([]);

  /** 筛选：每个单选字段独立的多选筛选值，key=fieldId, value=选中的选项数组 */
  const [filterMap, setFilterMap] = useState<Record<string, string[]>>({});

  /** 内联下拉弹窗状态 */
  const [inlineDropdown, setInlineDropdown] = useState<{
    visible: boolean;
    x: number;
    y: number;
    recordId: string;
    fieldId: string;
    options: string[];
  } | null>(null);

  // Refs to avoid stale closures in jsMind event listeners
  const labelFieldIdRef = useRef(effectiveLabelFieldId);
  const parentFieldIdRef = useRef(parentFieldId);
  const childFieldIdsRef = useRef(childFieldIds);
  const recordsRef = useRef(records);
  const fieldListRef = useRef(fieldList);
  const selectFieldsRef = useRef(selectFields);
  const statusFieldIdRef = useRef(statusFieldId);
  useEffect(() => { labelFieldIdRef.current = effectiveLabelFieldId; }, [effectiveLabelFieldId]);
  useEffect(() => { parentFieldIdRef.current = parentFieldId; }, [parentFieldId]);
  useEffect(() => { childFieldIdsRef.current = childFieldIds; }, [childFieldIds]);
  useEffect(() => { recordsRef.current = records; }, [records]);
  useEffect(() => { fieldListRef.current = fieldList; }, [fieldList]);
  useEffect(() => { selectFieldsRef.current = selectFields; }, [selectFields]);
  useEffect(() => { statusFieldIdRef.current = statusFieldId; }, [statusFieldId]);
  useEffect(() => { childFieldIdsRef.current = childFieldIds; }, [childFieldIds]);
  useEffect(() => { recordsRef.current = records; }, [records]);
  useEffect(() => { fieldListRef.current = fieldList; }, [fieldList]);
  useEffect(() => { selectFieldsRef.current = selectFields; }, [selectFields]);

  // 自动选择字段
  useEffect(() => {
    if (fieldList.length === 0) return;

    // 自动识别父记录字段
    if (!parentFieldId || !fieldList.some((f) => f.id === parentFieldId)) {
      const parentField = fieldList.find(
        (f) => f.name.includes('父') || f.name.toLowerCase().includes('parent')
      );
      if (parentField) setParentFieldId(parentField.id);
    }

    // 默认展开所有字段（排除节点名称字段和父记录字段）
    if (childFieldIds.length === 0) {
      const firstId = fieldList[0].id;
      const parentField = fieldList.find(
        (f) => f.name.includes('父') || f.name.toLowerCase().includes('parent')
      );
      const allOtherFields = fieldList.filter(
        (f) => f.id !== firstId && f.id !== (parentField?.id || '')
      );
      setChildFieldIds(allOtherFields.map((f) => f.id));
    }
  }, [fieldList]);

  // 需求2：收集所有单选字段及其选项，用于标记操作
  useEffect(() => {
    if (fieldList.length === 0) return;

    const singleSelects: { id: string; name: string; options: string[] }[] = [];
    fieldList.forEach((f) => {
      if (f.type === 3) {
        // 优先从字段元信息获取选项
        let opts: string[] = [];
        if (f.options && f.options.length > 0) {
          opts = f.options.map((o) => o.name);
        } else {
          // 兜底：从已有数据中提取
          const optSet = new Set<string>();
          records.forEach((r) => {
            const val = r.fields[f.id];
            if (val) optSet.add(val);
          });
          opts = Array.from(optSet);
        }
        if (opts.length > 0) {
          singleSelects.push({ id: f.id, name: f.name, options: opts });
        }
      }
    });
    setSelectFields(singleSelects);

    // 兼容旧逻辑：第一个匹配的单选字段作为默认 statusFieldId
    if (!statusFieldId && singleSelects.length > 0) {
      const preferred = singleSelects.find(
        (s) => s.name.includes('执行') || s.name.includes('状态') || s.name.includes('结果')
      );
      const chosen = preferred || singleSelects[0];
      setStatusFieldId(chosen.id);
      setStatusOptions(chosen.options);
    }
  }, [fieldList, records, statusFieldId]);

  // 初始化 jsMind 并渲染
  useEffect(() => {
    if (!containerRef.current || loading || !effectiveLabelFieldId) return;

    // records 为空时显示空状态
    if (records.length === 0) {
      if (jmRef.current) {
        const emptyMind = {
          meta: { name: 'testcase-mindmap', author: 'plugin', version: '1.0' },
          format: 'node_tree' as const,
          data: { id: 'root', topic: '暂无数据', children: [] },
        };
        try { jmRef.current.show(emptyMind); } catch {}
      }
      return;
    }

    // 筛选：多字段联合过滤（每个字段的选中值之间是 OR，字段之间是 AND）
    let filteredRecords = records;
    const activeFilters = Object.entries(filterMap).filter(([, vals]) => vals.length > 0);
    if (activeFilters.length > 0) {
      // 找出所有满足所有筛选条件的记录
      const matchedIds = new Set(
        records
          .filter((r) => activeFilters.every(([fid, vals]) => vals.includes(r.fields[fid] || '')))
          .map((r) => r.id)
      );
      // 向上追溯父节点，确保树结构完整
      const allIncluded = new Set<string>(matchedIds);
      const addAncestors = (recordId: string) => {
        const record = records.find((r) => r.id === recordId);
        if (!record || !parentFieldId) return;
        const parentValue = record.fields[parentFieldId];
        if (!parentValue) return;
        const parentRecord = records.find((r) => r.fields[effectiveLabelFieldId] === parentValue && r.id !== recordId);
        if (parentRecord && !allIncluded.has(parentRecord.id)) {
          allIncluded.add(parentRecord.id);
          addAncestors(parentRecord.id);
        }
      };
      matchedIds.forEach((id) => addAncestors(id));
      filteredRecords = records.filter((r) => allIncluded.has(r.id));
    }

    const root = buildJsMindData(filteredRecords, effectiveLabelFieldId, parentFieldId || undefined, childFieldIds, fieldList, statusFieldId);

    const mind = {
      meta: { name: 'testcase-mindmap', author: 'plugin', version: '1.0' },
      format: 'node_tree' as const,
      data: root,
    };

    // 如果 jsMind 已存在，销毁并重建（确保数据一致性）
    if (jmRef.current) {
      try { jmRef.current.destroy?.(); } catch {}
      containerRef.current.innerHTML = '';
      jmRef.current = null;
    }

    const options = {
      container: containerRef.current,
      editable: true,
      theme: 'greensea',
      mode: 'side' as const,
      view: {
        engine: 'svg' as const,
        draggable: true,
        hide_scrollbars_when_draggable: true,
        line_color: '#3370ff',
        line_width: 2,
        line_style: 'curved',
      },
      layout: {
        hspace: 60,
        vspace: 20,
        pspace: 13,
      },
      shortcut: {
        enable: true,
        handles: {},
        mapping: {
          addchild: 9,       // Tab → 添加子节点
          addbrother: 13,    // Enter → 添加同级节点
          editnode: 113,     // F2
          delnode: 46,       // Delete
          toggle: 32,        // Space
          left: 37,
          up: 38,
          right: 39,
          down: 40,
        },
      },
    };

    const jm = new jsMind(options);
    jm.show(mind);
    jmRef.current = jm;

    // 渲染后给节点染色（根据执行结果）
    const applyNodeColors = () => {
      const curStatusFieldId = statusFieldIdRef.current;
      console.log('[applyNodeColors] statusFieldId=', curStatusFieldId, 'records=', filteredRecords.length);
      if (!containerRef.current || !curStatusFieldId) return;
      filteredRecords.forEach((record) => {
        const statusValue = record.fields[curStatusFieldId] || '';
        const color = getStatusColor(statusValue);
        console.log('[applyNodeColors] record=', record.id, 'status=', statusValue, 'color=', color);
        if (!color) return;
        const nodeEl = containerRef.current?.querySelector(`jmnode[nodeid="${record.id}"]`) as HTMLElement;
        if (nodeEl) {
          nodeEl.style.setProperty('background-color', color.bg, 'important');
          nodeEl.style.setProperty('border-color', color.border, 'important');
          nodeEl.style.setProperty('color', color.text, 'important');
        }
      });
    };
    // 延迟执行确保 DOM 已渲染
    setTimeout(applyNodeColors, 300);

    // ===== 拦截快捷键：只阻止字段节点（3/4层）的 Enter/Tab/Delete =====
    const handleKeyDown = (e: KeyboardEvent) => {
      const curRecords = recordsRef.current;
      const curParentFieldId = parentFieldIdRef.current;

      if (!jm) return;
      const selectedNode = jm.get_selected_node();
      if (!selectedNode) return;

      const nodeId = selectedNode.id;
      const level = getNodeLevel(nodeId, curRecords, curParentFieldId);

      // 第3/4层节点：阻止 Enter/Tab/Delete
      if (level === NodeLevel.FIELD_NAME || level === NodeLevel.FIELD_VALUE) {
        if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Delete') {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // 第2层节点：阻止 Tab（不允许在用例下手动加子节点）
      if (level === NodeLevel.TESTCASE && e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    };

    // 在 capture 阶段拦截，优先于 jsMind 的事件处理
    containerRef.current.addEventListener('keydown', handleKeyDown, true);

    // 监听节点选中事件（type=4）：单选字段值节点被选中时弹出下拉
    jm.add_event_listener((type: number, data: any) => {
      if (type !== 4) return; // type 4 = select
      const curRecords = recordsRef.current;
      const curParentFieldId = parentFieldIdRef.current;

      const nodeId = data?.node || data?.data?.[0];
      if (!nodeId) return;

      const level = getNodeLevel(nodeId, curRecords, curParentFieldId);

      // 只有第4层（字段值节点）或第3层（字段名节点）才弹出下拉
      if (level !== NodeLevel.FIELD_VALUE && level !== NodeLevel.FIELD_NAME) {
        setInlineDropdown(null);
        return;
      }

      // 解析出 recordId 和 fieldId
      const recordId = resolveRecordId(nodeId, curRecords);
      if (!recordId) { setInlineDropdown(null); return; }

      let fieldId: string | null = null;
      if (level === NodeLevel.FIELD_VALUE) {
        fieldId = resolveFieldId(nodeId, recordId);
      } else {
        // 字段名节点 ID: {recordId}_{fieldId}
        fieldId = nodeId.slice(recordId.length + 1);
      }
      if (!fieldId) { setInlineDropdown(null); return; }

      // 检查该字段是否是单选字段
      const curFieldList = fieldListRef.current;
      const fieldMeta = curFieldList.find((f) => f.id === fieldId);
      if (!fieldMeta || fieldMeta.type !== 3) {
        setInlineDropdown(null);
        return;
      }

      // 获取选项列表
      const sf = selectFieldsRef.current.find((s) => s.id === fieldId);
      const options = sf?.options || [];
      if (options.length === 0) { setInlineDropdown(null); return; }

      // 获取节点 DOM 位置
      const nodeEl = containerRef.current?.querySelector(`jmnode[nodeid="${nodeId}"]`) as HTMLElement;
      if (!nodeEl) { setInlineDropdown(null); return; }

      const containerRect = containerRef.current!.getBoundingClientRect();
      const nodeRect = nodeEl.getBoundingClientRect();
      const x = nodeRect.right - containerRect.left + 4;
      const y = nodeRect.top - containerRect.top;

      setInlineDropdown({ visible: true, x, y, recordId, fieldId, options });
      console.log('[inline-dropdown] show:', { nodeId, recordId, fieldId, options, x, y });
    });

    // 监听编辑事件：节点文本修改、新增、删除后同步到多维表格
    jm.add_event_listener((type: number, data: any) => {
      // type 3 = edit
      if (type !== 3 || !data?.evt) return;

      const evt = data.evt;
      const curLabelFieldId = labelFieldIdRef.current;
      const curParentFieldId = parentFieldIdRef.current;
      const curRecords = recordsRef.current;

      console.log('[jsMind event] type=3, evt=', evt, 'data=', JSON.stringify(data));

      // --- 节点编辑（update_node）---
      if (evt === 'update_node') {
        // jsMind update_node 事件格式: data.node = nodeId, data.data 可能是新 topic
        // 或者 data.data = [nodeId, newTopic]
        let nodeId: string | undefined;
        let newTopic: string | undefined;

        if (data.node && typeof data.node === 'string') {
          nodeId = data.node;
          const foundNode = jm.get_node(data.node);
          newTopic = foundNode?.topic;
        } else if (Array.isArray(data.data) && data.data.length >= 2) {
          [nodeId, newTopic] = data.data;
        } else if (data.data && typeof data.data === 'object') {
          nodeId = data.data.id || data.data.node;
          newTopic = data.data.topic || data.data.name;
        }

        if (!nodeId || newTopic === undefined || nodeId === 'root') return;

        const level = getNodeLevel(nodeId!, curRecords, curParentFieldId);

        if (level === NodeLevel.FIELD_VALUE) {
          // 第4层：更新字段值
          const withoutVal = nodeId.slice(0, -4); // 去掉 _val
          const lastUnderscore = withoutVal.lastIndexOf('_');
          if (lastUnderscore > 0) {
            const recordId = withoutVal.slice(0, lastUnderscore);
            const fieldId = withoutVal.slice(lastUnderscore + 1);
            if (fieldId && recordId && curRecords.some((r) => r.id === recordId)) {
              const valueToWrite = newTopic === '(空)' ? '' : newTopic;
              updateField(recordId, fieldId, valueToWrite).then(() => {
                message.success('已更新字段值');
              }).catch((err) => message.error('更新失败: ' + err.message));
            }
          }
        } else if (level === NodeLevel.FIELD_NAME) {
          // 第3层：字段名不可编辑，恢复原值
          message.warning('字段名不可编辑');
          // 恢复原始字段名
          const lastUnderscore = nodeId.lastIndexOf('_');
          if (lastUnderscore > 0) {
            const fieldId = nodeId.slice(lastUnderscore + 1);
            const fieldInfo = fieldListRef.current.find((f) => f.id === fieldId);
            if (fieldInfo) {
              try { jm.update_node(nodeId, fieldInfo.name); } catch {}
            }
          }
        } else if (level === NodeLevel.MODULE || level === NodeLevel.TESTCASE) {
          // 第1/2层：更新记录名称
          if (curLabelFieldId) {
            updateField(nodeId, curLabelFieldId, newTopic).then(() => {
              message.success('已更新名称');
            }).catch((err) => message.error('更新失败: ' + err.message));
          }
        }
      }

      // --- 删除节点 ---
      if (evt === 'remove_node' && data?.data) {
        const removedNodeId = Array.isArray(data.data) ? data.data[0] : data.data;
        if (removedNodeId && curRecords.some((r) => r.id === removedNodeId)) {
          deleteRecord(removedNodeId).then(() => {
            message.success('已从表格删除');
          }).catch((err) => message.error('删除失败: ' + err.message));
        }
      }

      // --- 快捷键新增节点（Enter → insert_node_after, Tab → add_node）---
      if (evt === 'insert_node_after' || evt === 'insert_node_before' || evt === 'add_node') {
        // data.data 格式: [parentId, newNodeId, topic, ...]
        // data.node = newNodeId
        const newNodeId = data.node || (Array.isArray(data.data) && data.data[1]);
        if (!newNodeId || newNodeId === 'root') return;

        const newNode = jm.get_node(newNodeId);
        if (!newNode) return;

        const parentNode = newNode.parent;
        if (!parentNode) return;

        const topic = newNode.topic || 'New Node';

        // 判断父节点来决定写入方式
        if (curParentFieldId && parentNode.id !== 'root' && curRecords.some((r) => r.id === parentNode.id)) {
          // 父节点是记录 → 新增用例，关联父记录
          addRecord(curLabelFieldId, topic, curParentFieldId, parentNode.id).then(() => {
            refresh();
          }).catch((err) => message.error('同步失败: ' + err.message));
        } else {
          // 父节点是虚拟根或非记录 → 新增模块（无父记录）
          addRecord(curLabelFieldId, topic).then(() => {
            refresh();
          }).catch((err) => message.error('同步失败: ' + err.message));
        }
      }
    });

    return () => {
      containerRef.current?.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [records, loading, effectiveLabelFieldId, parentFieldId, childFieldIds, fieldList, statusFieldId, filterMap]);

  // 画布拖拽平移：鼠标左键按住拖动
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let origScrollLeft = 0;
    let origScrollTop = 0;

    const handleMouseDown = (e: MouseEvent) => {
      // 只在空白区域拖拽（不在节点上）
      const target = e.target as HTMLElement;
      if (target.closest('jmnode') || target.closest('jmexpander')) return;

      // 找到 jsmind-inner 容器
      const inner = container.querySelector('.jsmind-inner') as HTMLElement;
      if (!inner) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      origScrollLeft = inner.scrollLeft;
      origScrollTop = inner.scrollTop;
      container.style.cursor = 'grabbing';
      e.preventDefault();
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const inner = container.querySelector('.jsmind-inner') as HTMLElement;
      if (!inner) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      inner.scrollLeft = origScrollLeft - dx;
      inner.scrollTop = origScrollTop - dy;
    };

    const handleMouseUp = () => {
      if (isDragging) {
        isDragging = false;
        container.style.cursor = 'grab';
      }
    };

    container.style.cursor = 'grab';
    container.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      container.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // 新增子节点：父记录 = 选中节点的 recordId
  const handleAddChild = useCallback(async () => {
    const jm = jmRef.current;
    if (!jm || !effectiveLabelFieldId || !parentFieldId) {
      message.warning('请先选择"父记录"字段');
      return;
    }

    const node = jm.get_selected_node();
    if (!node || node.id === 'root') {
      message.warning('请先点击选中一个节点');
      return;
    }

    const parentId = node.id;
    if (!records.some((r) => r.id === parentId)) {
      message.warning('请选中一个记录节点');
      return;
    }

    try {
      await addRecord(effectiveLabelFieldId, '新用例', parentFieldId, parentId);
      message.success('已新增子节点');
      await refresh();
    } catch (err) {
      message.error('新增失败: ' + (err as Error).message);
    }
  }, [records, effectiveLabelFieldId, parentFieldId, addRecord, refresh]);

  // 新增同级节点
  const handleAddSibling = useCallback(async () => {
    const jm = jmRef.current;
    if (!jm || !effectiveLabelFieldId) {
      message.warning('请先选择字段');
      return;
    }

    const node = jm.get_selected_node();
    if (!node || node.id === 'root') {
      // 没有选中节点，新增根级模块
      try {
        await addRecord(effectiveLabelFieldId, '新模块');
        message.success('已新增根级节点');
        await refresh();
      } catch (err) {
        message.error('新增失败: ' + (err as Error).message);
      }
      return;
    }

    const level = getNodeLevel(node.id, records, parentFieldId);

    if (level === NodeLevel.FIELD_NAME || level === NodeLevel.FIELD_VALUE) {
      message.warning('字段节点不可手动添加同级');
      return;
    }

    const parentNode = node.parent;
    if (parentNode && parentNode.id !== 'root' && parentFieldId && records.some((r) => r.id === parentNode.id)) {
      try {
        await addRecord(effectiveLabelFieldId, '新用例', parentFieldId, parentNode.id);
        message.success('已新增同级节点');
        await refresh();
      } catch (err) {
        message.error('新增失败: ' + (err as Error).message);
      }
    } else {
      try {
        await addRecord(effectiveLabelFieldId, '新模块');
        message.success('已新增根级节点');
        await refresh();
      } catch (err) {
        message.error('新增失败: ' + (err as Error).message);
      }
    }
  }, [records, effectiveLabelFieldId, parentFieldId, addRecord, refresh]);

  // 点击单选下拉 → 更新多维表格对应字段，同时刷新思维导图
  const handleSelectOptionClick = useCallback(async (fieldId: string, optionValue: string) => {
    const jm = jmRef.current;
    if (!jm) {
      message.warning('请先选中一个用例节点');
      return;
    }
    const node = jm.get_selected_node();
    if (!node || node.id === 'root') {
      message.warning('请先选中一个用例节点');
      return;
    }

    // 从节点 ID 解析出所属的 recordId
    const recordId = resolveRecordId(node.id, records);
    if (!recordId) {
      message.warning('请选中一个用例节点或其字段节点');
      return;
    }

    try {
      await updateField(recordId, fieldId, optionValue);
      message.success(`已标记: ${optionValue}`);
      await refresh();
    } catch (err) {
      message.error('更新失败: ' + (err as Error).message);
    }
  }, [records, updateField, refresh]);

  // 全部展开：展开所有节点到叶子层级
  const handleExpandAll = useCallback(() => {
    const jm = jmRef.current;
    if (!jm || !jm.mind) return;
    const allNodes = jm.mind.nodes;
    for (const id in allNodes) {
      const node = allNodes[id];
      if (!node.isroot && !node.expanded) {
        try { jm.expand_node(id); } catch {}
      }
    }
  }, []);

  // 全部收起：只显示第一层（功能模块），其余全部折叠
  const handleCollapseAll = useCallback(() => {
    const jm = jmRef.current;
    if (!jm || !jm.mind) return;
    const allNodes = jm.mind.nodes;
    for (const id in allNodes) {
      const node = allNodes[id];
      if (!node.isroot && node.expanded) {
        // 只折叠第一层节点（根节点的直接子节点）
        const parent = node.parent;
        if (parent && parent.isroot) {
          try { jm.collapse_node(id); } catch {}
        }
      }
    }
  }, []);

  if (error) {
    return (
      <div className="error-container">
        <div className="error-icon">⚠️</div>
        <div className="error-message">{error.message}</div>
      </div>
    );
  }

  if (loading) {
    return <div className="loading">加载中...</div>;
  }

  return (
    <div className="mindmap-view">
      <div className="toolbar">
        <div className="field-selectors">
          <div className="field-selector">
            <span className="field-label">父记录:</span>
            <Select size="small" style={{ width: 100 }} value={parentFieldId || undefined} onChange={(v) => setParentFieldId(v || '')} allowClear placeholder="无">
              {fieldList.map((f) => <Select.Option key={f.id} value={f.id}>{f.name}</Select.Option>)}
            </Select>
          </div>
          <div className="field-selector">
            <span className="field-label">展开字段:</span>
            <Select size="small" mode="multiple" style={{ width: 140 }} value={childFieldIds} onChange={setChildFieldIds} maxTagCount={1} placeholder="字段">
              {fieldList.filter((f) => f.id !== effectiveLabelFieldId && f.id !== parentFieldId).map((f) => <Select.Option key={f.id} value={f.id}>{f.name}</Select.Option>)}
            </Select>
          </div>
          <button className="add-btn" onClick={handleAddSibling}>
            + 同级
          </button>
          <button className="add-btn" onClick={handleAddChild}>
            + 子节点
          </button>
          <button className="expand-btn" onClick={handleExpandAll}>
            全部展开
          </button>
          <button className="expand-btn" onClick={handleCollapseAll}>
            全部收起
          </button>
        </div>
        <div className="shortcut-hint">
          <span>Enter: 同级 | Tab: 子节点 | F2: 编辑 | Del: 删除 | Space: 折叠</span>
        </div>
      </div>

      {/* 单选字段操作栏 + 筛选栏 */}
      {selectFields.length > 0 && (
        <div className="select-fields-bar">
          {/* 每个单选字段：筛选 + 标记 */}
          {selectFields.map((sf) => (
            <div key={sf.id} className="select-field-row">
              <span className="select-field-name">{sf.name}:</span>
              {/* 筛选多选 */}
              <Select
                size="small"
                mode="multiple"
                style={{ width: 160 }}
                placeholder="筛选"
                value={filterMap[sf.id] || []}
                onChange={(vals: string[]) =>
                  setFilterMap((prev) => ({ ...prev, [sf.id]: vals }))
                }
                allowClear
                onClear={() => setFilterMap((prev) => { const n = { ...prev }; delete n[sf.id]; return n; })}
              >
                {sf.options.map((opt) => {
                  const color = getStatusColor(opt);
                  return (
                    <Select.Option key={opt} value={opt}>
                      <span style={color ? { color: color.text, fontWeight: 500 } : {}}>{opt}</span>
                    </Select.Option>
                  );
                })}
              </Select>
              {/* 标记操作 */}
              <Select
                size="small"
                style={{ width: 90 }}
                placeholder="标记"
                value={undefined}
                onChange={(val: string) => handleSelectOptionClick(sf.id, val)}
              >
                {sf.options.map((opt) => {
                  const color = getStatusColor(opt);
                  return (
                    <Select.Option key={opt} value={opt}>
                      <span style={color ? { color: color.text } : {}}>{opt}</span>
                    </Select.Option>
                  );
                })}
              </Select>
            </div>
          ))}
          <span className="selected-hint">← 先选中节点再标记</span>
        </div>
      )}

      <div ref={containerRef} className="minder-container" />

      {/* 内联下拉选择器：点击单选字段节点时弹出 */}
      {inlineDropdown && inlineDropdown.visible && (
        <div
          className="inline-dropdown-overlay"
          onClick={() => setInlineDropdown(null)}
        >
          <div
            className="inline-dropdown"
            style={{ top: inlineDropdown.y, left: inlineDropdown.x }}
            onClick={(e) => e.stopPropagation()}
          >
            {inlineDropdown.options.map((opt) => (
              <div
                key={opt}
                className="inline-dropdown-item"
                onClick={async () => {
                  const { recordId, fieldId } = inlineDropdown;
                  console.log('[inline-dropdown] updating:', recordId, fieldId, '→', opt);
                  setInlineDropdown(null);
                  try {
                    await updateField(recordId, fieldId, opt);
                    message.success(`已标记: ${opt}`);
                    await refresh();
                  } catch (err) {
                    message.error('更新失败: ' + (err as Error).message);
                  }
                }}
              >
                {opt}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
