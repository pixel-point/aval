export const AVAL_SHADOW_STYLE = `
:host{display:inline-block;position:relative;overflow:hidden;box-sizing:border-box;contain:layout paint;aspect-ratio:auto;inline-size:auto;block-size:auto}
:host([hidden]){display:none!important}
canvas{position:absolute;inset:0;box-sizing:border-box;inline-size:100%;block-size:100%}
canvas{object-fit:contain;pointer-events:none}
[hidden]{display:none!important}
`;
