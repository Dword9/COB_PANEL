import React, { useState, useEffect } from 'react';
import { Save, FolderOpen, X, Clock, Trash2, Edit3, MessageSquare } from 'lucide-react';

interface ProjectSlot {
    id: string; // Filename on server
    name: string;
    comment: string;
    date: string;
    isEmpty: boolean;
}

interface ProjectManagerProps {
    isOpen: boolean;
    mode: 'save' | 'load';
    onClose: () => void;
    onSelectSlot: (name: string, comment?: string) => void;
    onDeleteSlot: (name: string) => Promise<void> | void;
}

const ProjectManager: React.FC<ProjectManagerProps> = ({ isOpen, mode, onClose, onSelectSlot, onDeleteSlot }) => {
    const [projects, setProjects] = useState<ProjectSlot[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    
    // Save state
    const [projectName, setProjectName] = useState('');
    const [projectComment, setProjectComment] = useState('');

    const fetchProjects = async () => {
        setIsLoading(true);
        setLoadError(null);
        try {
            const res = await fetch('/api/projects');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setProjects(data.map((p: any) => ({
                id: p.id,
                name: p.name,
                comment: p.comment || '',
                date: new Date(p.timestamp).toLocaleString('ru-RU'),
                isEmpty: false
            })));
        } catch (e) {
            console.error("Failed to fetch projects", e);
            setLoadError("Не удалось загрузить список проектов");
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen) {
            fetchProjects();
            setProjectName('');
            setProjectComment('');
        }
    }, [isOpen]);

    const handleAction = (project: ProjectSlot) => {
        if (mode === 'load') {
            onSelectSlot(project.id);
        } else if (mode === 'save') {
            // Overwrite mode: pre-fill fields
            setProjectName(project.name);
            setProjectComment(project.comment);
        }
    };

    const onSaveNew = () => {
        const name = projectName.trim();
        if (!name) {
            alert("Введите имя проекта!");
            return;
        }
        const existing = projects.find(p => p.name.trim().toLowerCase() === name.toLowerCase());
        if (existing && !window.confirm(`Проект «${existing.name}» уже существует. Перезаписать его?`)) {
            return;
        }
        onSelectSlot(name, projectComment);
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="w-[600px] bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-2xl animate-in zoom-in-95 duration-200 flex flex-col max-h-[80vh]">
                <div className="flex justify-between items-center mb-6">
                    <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-xl ${mode === 'save' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-blue-500/10 text-blue-500'}`}>
                            {mode === 'save' ? <Save size={20} /> : <FolderOpen size={20} />}
                        </div>
                        <div>
                            <h2 className="text-lg font-black text-white uppercase tracking-tight">
                                {mode === 'save' ? 'Сохранить проект' : 'Загрузить проект'}
                            </h2>
                            <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">
                                {mode === 'save' ? 'Укажите имя и описание' : 'Выберите проект из списка'}
                            </p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-zinc-800 rounded-full text-zinc-500 hover:text-white transition-all">
                        <X size={20} />
                    </button>
                </div>

                {mode === 'save' && (
                    <div className="mb-6 space-y-4 p-4 bg-zinc-950 border border-zinc-800 rounded-2xl">
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-zinc-600 uppercase flex items-center gap-2">
                                <Edit3 size={10} /> Имя проекта
                            </label>
                            <input 
                                type="text" 
                                value={projectName}
                                onChange={(e) => setProjectName(e.target.value)}
                                placeholder="Например: Scene_01_Main"
                                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-2.5 text-sm text-emerald-500 outline-none focus:border-emerald-500/50"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-zinc-600 uppercase flex items-center gap-2">
                                <MessageSquare size={10} /> Комментарий / Описание
                            </label>
                            <textarea 
                                value={projectComment}
                                onChange={(e) => setProjectComment(e.target.value)}
                                placeholder="Краткое описание того, что в этом проекте..."
                                className="w-full h-20 bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-2.5 text-sm text-zinc-300 outline-none focus:border-emerald-500/50 resize-none"
                            />
                        </div>
                        <button 
                            onClick={onSaveNew}
                            className="w-full bg-emerald-500 text-black font-black text-[11px] py-3 rounded-xl hover:bg-emerald-400 transition-all active:scale-95 shadow-lg shadow-emerald-500/10"
                        >
                            СОХРАНИТЬ В ФАЙЛ НА СЕРВЕРЕ
                        </button>
                    </div>
                )}

                <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                    {isLoading ? (
                        <div className="flex flex-col items-center justify-center py-10 gap-3 text-zinc-600">
                            <div className="w-6 h-6 border-2 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin" />
                            <span className="text-[10px] font-black uppercase">Загрузка списка...</span>
                        </div>
                    ) : loadError ? (
                        <div className="flex flex-col items-center justify-center py-10 gap-3 text-red-500 border-2 border-dashed border-red-500/30 rounded-2xl">
                            <span className="text-[10px] font-black uppercase">{loadError}</span>
                            <button onClick={fetchProjects} className="px-4 py-1.5 bg-red-500/10 hover:bg-red-500/20 rounded-lg text-[10px] font-black uppercase transition-all">
                                Повторить
                            </button>
                        </div>
                    ) : projects.length === 0 ? (
                        <div className="text-center py-10 text-zinc-600 border-2 border-dashed border-zinc-800 rounded-2xl">
                            <span className="text-[10px] font-black uppercase">Проектов пока нет</span>
                        </div>
                    ) : (
                        projects.map((project) => (
                            <div key={project.id} className="group relative flex items-center bg-zinc-950 border border-zinc-800 rounded-2xl p-4 hover:border-zinc-700 transition-all">
                                <button
                                    onClick={() => handleAction(project)}
                                    className={`flex-1 flex text-left cursor-pointer`}
                                >
                                    <div className="flex-1">
                                        <div className="text-sm font-black text-white group-hover:text-emerald-500 transition-colors uppercase flex items-center gap-2">
                                            {project.name}
                                            {mode === 'save' && projectName === project.name && (
                                                <span className="text-[8px] bg-emerald-500 text-black px-1.5 py-0.5 rounded animate-pulse">ВЫБРАНО</span>
                                            )}
                                        </div>
                                        {project.comment && (
                                            <div className="text-[11px] text-zinc-500 line-clamp-1 mt-0.5">
                                                {project.comment}
                                            </div>
                                        )}
                                        <div className="text-[9px] font-bold text-zinc-600 flex items-center gap-1 mt-1">
                                            <Clock size={10} />
                                            {project.date}
                                        </div>
                                    </div>
                                    <div className="flex items-center text-zinc-700 group-hover:text-blue-500 transition-colors">
                                        {mode === 'load' ? <FolderOpen size={18} /> : <Edit3 size={18} className="text-zinc-800 group-hover:text-emerald-500" />}
                                    </div>
                                </button>
                                
                                <button 
                                    onClick={(e) => { e.stopPropagation(); void (async () => { await onDeleteSlot(project.id); await fetchProjects(); })(); }}
                                    className="ml-4 p-2 bg-red-500/10 text-red-500 rounded-lg hover:bg-red-500 hover:text-white transition-all shadow-lg"
                                    title="Удалить проект"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        ))
                    )}
                </div>

                <div className="mt-6 text-[9px] text-zinc-600 font-bold uppercase text-center tracking-widest border-t border-zinc-800 pt-4">
                    Папка сохранения: <code className="text-zinc-500">./projects/</code>
                </div>
            </div>
        </div>
    );
};

export default ProjectManager;
