import {jsPDF} from 'jspdf';import {expect,it} from 'vitest';
it('retains multipage image/text export with the security-patched PDF library',()=>{
 const pdf=new jsPDF({unit:'mm',format:'a4'});pdf.text('Fictional clinical export',10,10);
 pdf.addImage('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==','PNG',10,20,5,5);
 pdf.addPage();pdf.text('Fictional second page',10,10);
 const bytes=Buffer.from(pdf.output('arraybuffer'));expect(bytes.subarray(0,5).toString()).toBe('%PDF-');expect(pdf.getNumberOfPages()).toBe(2);expect(bytes.length).toBeGreaterThan(1000);
});
