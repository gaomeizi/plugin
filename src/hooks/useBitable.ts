import { useState, useEffect, useCallback, useRef } from 'react';
import { bitable, ITable, IFieldMeta } from '@lark-base-open/js-sdk';
import { BATCH_SIZE } from '../constants';

export interface RecordData {
  id: string;
  fields: Record<string, string>;
}

export interface FieldInfo {
  id: string;
  name: string;
  type: number;
  /** 单选/多选字段的选项列表 */
  options?: { name: string; id?: string; color?: number }[];
}

export interface UseBitableReturn {
  records: RecordData[];
  fieldList: FieldInfo[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  /** 新增记录，返回记录 ID */
  addRecord: (labelFieldId: string, label: string, parentFieldId?: string, parentLabel?: string) => Promise<string>;
  /** 更新记录的某个字段值 */
  updateField: (recordId: string, fieldId: string, value: string) => Promise<void>;
  /** 删除记录 */
  deleteRecord: (recordId: string) => Promise<void>;
}

/** 从单元格值中提取纯文本 */
function cellToText(cellValue: unknown): string {
  if (cellValue === null || cellValue === undefined) return '';
  if (Array.isArray(cellValue)) {
    return cellValue.map((seg: any) => seg?.text || seg?.name || '').join('');
  }
  if (typeof cellValue === 'object') {
    const obj = cellValue as any;
    if (obj.text) return obj.text;
    if (obj.name) return obj.name;
    if (obj.value) return String(obj.value);
  }
  if (typeof cellValue === 'string' || typeof cellValue === 'number' || typeof cellValue === 'boolean') {
    return String(cellValue);
  }
  return '';
}

export function useBitable(): UseBitableReturn {
  const [records, setRecords] = useState<RecordData[]>([]);
  const [fieldList, setFieldList] = useState<FieldInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const tableRef = useRef<ITable | null>(null);
  const fieldMetaRef = useRef<IFieldMeta[]>([]);
  const skipRefreshCountRef = useRef(0);

  useEffect(() => {
    init();
  }, []);

  const init = async () => {
    try {
      const t = await bitable.base.getActiveTable();
      tableRef.current = t;
      const fields = await t.getFieldMetaList();
      fieldMetaRef.current = fields;

      // 按视图显示顺序排列字段（确保第一列是表格里真正的第一列）
      let orderedFields = fields;
      try {
        const view = await t.getActiveView();
        const visibleIds = await view.getVisibleFieldIdList();
        const idToField = new Map(fields.map((f) => [f.id, f]));
        const ordered = visibleIds.map((id) => idToField.get(id)).filter(Boolean) as IFieldMeta[];
        // 补上视图中不可见但存在的字段
        const visibleSet = new Set(visibleIds);
        const hidden = fields.filter((f) => !visibleSet.has(f.id));
        orderedFields = [...ordered, ...hidden];
      } catch (e) {
        console.warn('[useBitable] getVisibleFieldIdList failed, using default order:', e);
      }

      setFieldList(orderedFields.map((f) => {
        const info: FieldInfo = { id: f.id, name: f.name, type: f.type };
        if ((f.type === 3 || f.type === 4) && (f as any).property?.options) {
          info.options = (f as any).property.options.map((opt: any) => ({
            name: opt.name,
            id: opt.id,
            color: opt.color,
          }));
        }
        return info;
      }));
      await loadRecords(t, fields);
    } catch (err) {
      console.error('[useBitable] init error:', err);
      setError(err as Error);
      setLoading(false);
    }
  };

  useEffect(() => {
    const t = tableRef.current;
    if (!t) return;
    const handleChange = async () => {
      if (skipRefreshCountRef.current > 0) {
        skipRefreshCountRef.current--;
        return;
      }
      await loadRecords(t, fieldMetaRef.current);
    };
    const offModify = t.onRecordModify(handleChange);
    const offAdd = t.onRecordAdd(handleChange);
    const offDelete = t.onRecordDelete(handleChange);
    return () => { offModify(); offAdd(); offDelete(); };
  }, [fieldList]);

  const isFirstLoad = useRef(true);

  const loadRecords = async (t: ITable, fields: IFieldMeta[]) => {
    // 只在首次加载时显示 loading，后续刷新不设 loading（避免思维导图闪烁消失）
    if (isFirstLoad.current) {
      setLoading(true);
    }
    try {
      const allRecords: RecordData[] = [];
      let hasMore = true;
      let pageToken: string | undefined;

      while (hasMore) {
        const response = await t.getRecords({
          pageSize: BATCH_SIZE,
          ...(pageToken && { pageToken }),
        });
        for (const record of response.records) {
          const fieldValues: Record<string, string> = {};
          for (const field of fields) {
            fieldValues[field.id] = cellToText(record.fields[field.id]);
          }
          allRecords.push({ id: record.recordId, fields: fieldValues });
        }
        hasMore = response.hasMore;
        if (hasMore && response.records.length > 0) {
          pageToken = response.records[response.records.length - 1].recordId;
        } else {
          hasMore = false;
        }
      }
      setRecords(allRecords);
    } catch (err) {
      console.error('[useBitable] loadRecords error:', err);
      setError(err as Error);
    } finally {
      setLoading(false);
      isFirstLoad.current = false;
    }
  };

  /** 新增一条记录到多维表格 */
  const addRecord = useCallback(async (
    labelFieldId: string,
    label: string,
    parentFieldId?: string,
    parentRecordId?: string
  ): Promise<string> => {
    const t = tableRef.current;
    if (!t) throw new Error('表格未初始化');

    // 先创建记录（只写名称字段）
    const fields: Record<string, any> = {
      [labelFieldId]: [{ type: 'text', text: label }],
    };
    skipRefreshCountRef.current += 2; // addRecord + setCellValue each trigger an event
    const recordId = await t.addRecord({ fields });
    console.log('[addRecord] created recordId:', recordId);

    // 如果有关联字段，用 setCellValue 写入
    if (parentFieldId && parentRecordId) {
      const fieldMeta = fieldMetaRef.current.find((f) => f.id === parentFieldId);
      const fieldType = fieldMeta?.type;

      if (fieldType === 15 || fieldType === 18 || fieldType === 21) {
        // 关联字段：直接用 parentRecordId
        try {
          await t.setCellValue(parentFieldId, recordId, { recordIds: [parentRecordId] } as any);
          console.log('[addRecord] setCellValue link to:', parentRecordId);
        } catch (e) {
          console.error('[addRecord] setCellValue failed:', e);
        }
      } else {
        // 文本字段：写入父节点名称
        const parentRecord = records.find((r) => r.id === parentRecordId);
        const parentName = parentRecord?.fields[labelFieldId] || '';
        if (parentName) {
          await t.setRecord(recordId, {
            fields: { [parentFieldId]: [{ type: 'text', text: parentName }] as any }
          });
        }
      }
    }

    return recordId;
  }, [records]);

  /** 更新记录的某个字段（支持文本和单选） */
  const updateField = useCallback(async (
    recordId: string,
    fieldId: string,
    value: string
  ): Promise<void> => {
    const t = tableRef.current;
    if (!t) throw new Error('表格未初始化');

    skipRefreshCountRef.current += 1;
    const fieldMeta = fieldMetaRef.current.find((f) => f.id === fieldId);

    if (fieldMeta && (fieldMeta.type === 3 || fieldMeta.type === 4)) {
      // 单选/多选字段：通过 field 对象的 setValue 方法写入（接受纯字符串）
      console.log('[updateField] select field setValue:', recordId, fieldId, value);
      const field = await t.getField(fieldId);
      await (field as any).setValue(recordId, value);
    } else {
      // 文本字段：用 setRecord 写入
      const cellValue = [{ type: 'text', text: value }];
      await t.setRecord(recordId, {
        fields: { [fieldId]: cellValue as any },
      });
    }
  }, []);

  /** 删除记录 */
  const deleteRecord = useCallback(async (recordId: string): Promise<void> => {
    const t = tableRef.current;
    if (!t) throw new Error('表格未初始化');
    skipRefreshCountRef.current += 1;
    await t.deleteRecord(recordId);
  }, []);

  const refresh = useCallback(async () => {
    if (tableRef.current && fieldMetaRef.current.length > 0) {
      await loadRecords(tableRef.current, fieldMetaRef.current);
    }
  }, []);

  return {
    records,
    fieldList,
    loading,
    error,
    refresh,
    addRecord,
    updateField,
    deleteRecord,
  };
}
