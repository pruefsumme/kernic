export interface TemplateFile {
	path: string;
	content: string;
}

export const templateCategories = ['Basics', 'Academic', 'Reports', 'Letters'] as const;
export type TemplateCategory = (typeof templateCategories)[number];

export interface ProjectTemplate {
	id: string;
	name: string;
	category: TemplateCategory;
	description: string;
	entryPath: string;
	files: TemplateFile[];
}

// Template sources are bundled into the server build, so they are available
// without touching the file system at runtime.
const sources = import.meta.glob<string>('./templates/**/*', {
	query: '?raw',
	import: 'default',
	eager: true
});

function filesOf(templateId: string): TemplateFile[] {
	const prefix = `./templates/${templateId}/`;
	return Object.entries(sources)
		.filter(([file]) => file.startsWith(prefix))
		.map(([file, content]) => ({ path: file.slice(prefix.length), content }))
		.sort((a, b) => a.path.localeCompare(b.path));
}

// Built-in templates use no external packages, so they compile on servers
// without access to the Typst package registry.
export const templates: ProjectTemplate[] = [
	{
		id: 'blank',
		name: 'Blank document',
		category: 'Basics',
		description: 'One empty file. Start from nothing.',
		entryPath: 'main.typ',
		files: filesOf('blank')
	},
	{
		id: 'article',
		name: 'Article',
		category: 'Academic',
		description: 'Numbered sections, abstract, a table and a bibliography.',
		entryPath: 'main.typ',
		files: filesOf('article')
	},
	{
		id: 'report',
		name: 'Report',
		category: 'Reports',
		description: 'Title page, contents and one file per chapter.',
		entryPath: 'main.typ',
		files: filesOf('report')
	},
	{
		id: 'letter',
		name: 'Letter',
		category: 'Letters',
		description: 'A one-page formal letter.',
		entryPath: 'main.typ',
		files: filesOf('letter')
	}
];

export function findTemplate(id: string): ProjectTemplate | undefined {
	return templates.find((template) => template.id === id);
}
