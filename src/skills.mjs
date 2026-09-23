import path from 'node:path';

// Phone clients select an ID only. Names and paths come from the installed Codex catalog.
const definitions = Object.freeze([
  { id: 'word', title: 'Word 文档', description: '起草、修改和排版 Word 文档', name: 'documents:documents', pluginId: 'documents@openai-primary-runtime' },
  { id: 'ppt', title: 'PPT 演示', description: '制作、修改和整理演示文稿', name: 'presentations:Presentations', pluginId: 'presentations@openai-primary-runtime' },
  { id: 'excel', title: 'Excel 表格', description: '整理数据、公式、分析和图表', name: 'spreadsheets:Spreadsheets', pluginId: 'spreadsheets@openai-primary-runtime' },
  { id: 'pdf', title: 'PDF 处理', description: '阅读、提取内容和制作 PDF', name: 'pdf:pdf', pluginId: 'pdf@openai-primary-runtime' },
  { id: 'development', title: '软件开发', description: '梳理需求、编写代码、修复和验证', name: 'development-workflow:development-workflow', pluginId: 'development-workflow@personal' },
]);
const failure = (message, statusCode) => Object.assign(new Error(message), { statusCode });
export function skillDefinition(id) {
  if (id === undefined || id === '') return null;
  const definition = definitions.find(item => item.id === id);
  if (!definition) throw failure('技能选择无效，请重新选择', 400);
  return definition;
}
export async function installedSkills(client, cwd) {
  let result;
  try { result = await client.request('skills/list', { cwds: [cwd], forceReload: true }); }
  catch { throw failure('暂时无法读取电脑技能，请稍后重试', 503); }
  const scope = Array.isArray(result?.data) ? result.data.find(item => typeof item?.cwd === 'string' && path.relative(item.cwd, cwd) === '') : null;
  if (!Array.isArray(scope?.skills)) throw failure('暂时无法读取电脑技能，请稍后重试', 503);
  return definitions.map(definition => {
    const matches = scope.skills.filter(item => item?.enabled === true && item.name === definition.name && item.pluginId === definition.pluginId &&
      typeof item.path === 'string' && path.isAbsolute(item.path) && path.basename(item.path) === 'SKILL.md');
    return { definition, skill: matches.length === 1 ? matches[0] : null };
  });
}
export async function listSkills(client, cwd) {
  return (await installedSkills(client, cwd)).map(({ definition, skill }) => ({
    id: definition.id, title: definition.title, description: definition.description, available: Boolean(skill),
  }));
}
export async function skillInput(client, cwd, id, prompt) {
  const definition = skillDefinition(id);
  if (!definition) return [{ type: 'text', text: prompt }];
  const { skill } = (await installedSkills(client, cwd)).find(item => item.definition.id === id);
  if (!skill) throw failure(`${definition.title}技能当前不可用，请重新选择技能，或选择“不指定”后发送`, 409);
  return [{ type: 'text', text: `$${skill.name}\n${prompt}` }, { type: 'skill', name: skill.name, path: skill.path }];
}
