const fs = require('fs');

function patchFile(path) {
  let content = fs.readFileSync(path, 'utf8');

  // Change expect(res.body) when it expects an array
  content = content.replace(/expect\(res\.body\)\.toEqual\(\[\]\)/g, "expect(res.body.items).toEqual([])");
  content = content.replace(/expect\(res\.body\)\.toEqual\(expect\.arrayContaining\(\[/g, "expect(res.body.items).toEqual(expect.arrayContaining([");
  content = content.replace(/expect\(Array\.isArray\(res\.body\)\)/g, "expect(Array.isArray(res.body.items))");
  content = content.replace(/res\.body\.length/g, "res.body.items.length");
  content = content.replace(/of res\.body\)/g, "of res.body.items)");
  content = content.replace(/of res\.body\s*\{/g, "of res.body.items {");
  content = content.replace(/res\.body\[/g, "res.body.items[");
  content = content.replace(/res\.body\.map/g, "res.body.items.map");
  content = content.replace(/res\.body\.filter/g, "res.body.items.filter");
  
  // Specific for gmail messages
  if (path.includes('gmail.test.ts')) {
    content = content.replace(/res\.body\.total/g, "res.body.items.length"); // just for simple testing
    content = content.replace(/res\.body\.messages/g, "res.body.items");
  }

  fs.writeFileSync(path, content, 'utf8');
}

['src/tests/application.test.ts', 'src/tests/email.test.ts', 'src/tests/gmail.test.ts', 'src/tests/action.test.ts'].forEach(patchFile);
