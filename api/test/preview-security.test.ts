import {readFileSync} from 'node:fs';import {Script,runInNewContext} from 'node:vm';import {expect,it} from 'vitest';
it('prevents print-preview content from executing scripts or navigating the parent',()=>{
 const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
 const tree=runInNewContext(html.slice(html.indexOf('function PreviewModal('),html.indexOf('function SaveBtn('))+';PreviewModal({html:"<p>Fictional preview</p>",onClose(){}})',{T:'#0080a0',React:{createElement:(type:any,props:any,...children:any[])=>({type,props,children})}});
 const flatten=(n:any):any[]=>!n||typeof n!=='object'?[]:[n,...n.children.flat(Infinity).flatMap(flatten)];const frame=flatten(tree).find(n=>n.type==='iframe');
 expect(frame.props.sandbox).toBe('allow-same-origin allow-modals');
});
it('injects a valid dirty-state bridge only into owned clinical form HTML',()=>{
 const source=readFileSync(new URL('../src/http/pages.ts',import.meta.url),'utf8'),start=source.indexOf('const EMBED_FIX = '),end=source.indexOf('// Only scripts',start);
 const make=runInNewContext(source.slice(start,end).replace('(nonce: string)','(nonce)')+';EMBED_FIX');
 const outer=make('fictional-nonce'),context:any={window:{},location:{origin:'http://clinic.local'}};
 runInNewContext(outer.slice(outer.indexOf('>')+1,outer.lastIndexOf('</script>')),context);
 const output=context.window.__kbEmbed('<html><head></head><body><script>var type="KB_SAVE_RECORD";</script></body></html>');
 expect(output).toContain('KB_FORM_DIRTY');expect(output).toContain('</script></head>');
 for(const match of output.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))expect(()=>new Script(match[1])).not.toThrow();
});
