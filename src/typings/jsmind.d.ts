declare module 'jsmind' {
  interface JsMindOptions {
    container: HTMLElement | string;
    editable?: boolean;
    theme?: string;
    mode?: 'full' | 'side';
    support_html?: boolean;
    view?: {
      engine?: 'canvas' | 'svg';
      draggable?: boolean;
      hide_scrollbars_when_draggable?: boolean;
      line_color?: string;
      line_width?: number;
      line_style?: string;
    };
    layout?: {
      hspace?: number;
      vspace?: number;
      pspace?: number;
    };
    shortcut?: {
      enable?: boolean;
      handles?: Record<string, any>;
      mapping?: Record<string, number>;
    };
  }

  interface JsMindNode {
    id: string;
    topic: string;
    children?: JsMindNode[];
    direction?: 'left' | 'right';
    parent?: JsMindNode | null;
    expanded?: boolean;
    isroot?: boolean;
  }

  interface JsMindData {
    meta: { name: string; author: string; version: string };
    format: 'node_tree' | 'node_array' | 'freemind';
    data: JsMindNode;
  }

  interface JsMindMind {
    nodes: Record<string, JsMindNode>;
  }

  class jsMind {
    constructor(options: JsMindOptions);
    mind: JsMindMind | null;
    show(mind: JsMindData): void;
    get_data(format?: string): JsMindData;
    get_node(id: string): JsMindNode | null;
    get_selected_node(): JsMindNode | null;
    add_node(parent: any, id: string, topic: string): any;
    remove_node(id: string): void;
    update_node(id: string, topic: string): void;
    select_node(id: string): void;
    collapse_node(id: string): void;
    expand_node(id: string): void;
    add_event_listener(handler: (type: number, data: any) => void): void;
    destroy?(): void;
  }

  export default jsMind;
}

declare module 'jsmind/style/jsmind.css' {
  const content: string;
  export default content;
}
