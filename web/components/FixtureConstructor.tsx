import React, { useState } from 'react';
import { X, Plus, Trash2, Settings2, Save } from 'lucide-react';

interface ChannelDef {
    label: string;
    type: string;
}

interface FixtureConstructorProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (name: string, startChannel: number, channels: ChannelDef[]) => void;
}

const FixtureConstructor: React.FC<FixtureConstructorProps> = ({ isOpen, onClose, onSave }) => {
    const [name, setName] = useState('New Custom Fixture');
    const [startChannel, setStartChannel] = useState(1);
    const [channels, setChannels] = useState<ChannelDef[]>([
        { label: 'Dimmer', type: 'intensity' }
    ]);

    // Сброс состояния при каждом открытии конструктора
    React.useEffect(() => {
        if (isOpen) {
            setName('New Custom Fixture');
            setStartChannel(1);
            setChannels([{ label: 'Dimmer', type: 'intensity' }]);
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const addChannel = () => {
        setChannels([...channels, { label: `Ch ${channels.length + 1}`, type: 'fx' }]);
    };

    const removeChannel = (idx: number) => {
        if (channels.length <= 1) return;
        setChannels(channels.filter((_, i) => i !== idx));
    };

    const updateChannel = (idx: number, field: keyof ChannelDef, val: string) => {
        const next = [...channels];
        next[idx] = { ...next[idx], [field]: val };
        setChannels(next);
    };

    const handleSave = () => {
        if (!name.trim()) return alert("Введите имя прибора!");
        if (startChannel < 1 || startChannel + channels.length - 1 > 512) {
            return alert(`Прибор не влезает в юниверс: каналы ${startChannel}–${startChannel + channels.length - 1}, допустимо 1–512.`);
        }
        onSave(name, startChannel, channels);
        onClose();
    };

    return (
        <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
            <div className="w-[450px] bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-2xl animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
                <div className="flex justify-between items-center mb-6">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-xl bg-blue-500/10 text-blue-500">
                            <Settings2 size={20} />
                        </div>
                        <div>
                            <h2 className="text-lg font-black text-white uppercase tracking-tight">Конструктор прибора</h2>
                            <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Создайте кастомную конфигурацию</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-zinc-800 rounded-full text-zinc-500 hover:text-white transition-all">
                        <X size={20} />
                    </button>
                </div>

                <div className="space-y-4 mb-6">
                    <div className="grid grid-cols-3 gap-4">
                        <div className="col-span-2 space-y-1.5">
                            <label className="text-[9px] font-black text-zinc-600 uppercase">Имя прибора</label>
                            <input 
                                type="text" 
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-sm text-white outline-none focus:border-blue-500/50"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-[9px] font-black text-zinc-600 uppercase">DMX Адрес</label>
                            <input 
                                type="number" 
                                min="1" max="512"
                                value={startChannel}
                                onChange={(e) => setStartChannel(parseInt(e.target.value) || 1)}
                                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-sm text-blue-500 font-bold outline-none focus:border-blue-500/50"
                            />
                        </div>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-2">
                    <div className="text-[9px] font-black text-zinc-600 uppercase tracking-widest mb-2 flex justify-between items-center px-1">
                        <span>Каналы управления ({channels.length})</span>
                        <button onClick={addChannel} className="text-blue-500 hover:text-blue-400 flex items-center gap-1">
                            <Plus size={10} strokeWidth={3} /> ДОБАВИТЬ
                        </button>
                    </div>

                    {channels.map((ch, idx) => (
                        <div key={idx} className="flex gap-2 bg-zinc-950/50 border border-zinc-800/50 rounded-xl p-2 items-center group">
                            <div className="w-6 text-[10px] font-black text-zinc-700 text-center">
                                {idx + 1}
                            </div>
                            <input 
                                type="text" 
                                value={ch.label}
                                onChange={(e) => updateChannel(idx, 'label', e.target.value)}
                                placeholder="Label"
                                className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-[11px] text-zinc-300 outline-none focus:border-blue-500/30"
                            />
                            <select 
                                value={ch.type}
                                onChange={(e) => updateChannel(idx, 'type', e.target.value)}
                                className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-[10px] text-zinc-500 outline-none cursor-pointer"
                            >
                                <option value="intensity">Dimmer</option>
                                <option value="red">Red</option>
                                <option value="green">Green</option>
                                <option value="blue">Blue</option>
                                <option value="white">White</option>
                                <option value="pan">Pan</option>
                                <option value="tilt">Tilt</option>
                                <option value="strobe">Strobe</option>
                                <option value="fx">FX / Other</option>
                            </select>
                            <button 
                                onClick={() => removeChannel(idx)}
                                className="p-1.5 text-zinc-700 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                            >
                                <Trash2 size={12} />
                            </button>
                        </div>
                    ))}
                </div>

                <div className="mt-6 pt-4 border-t border-zinc-800">
                    <button 
                        onClick={handleSave}
                        className="w-full bg-blue-600 text-white font-black text-[11px] py-3 rounded-xl hover:bg-blue-500 transition-all active:scale-95 shadow-lg shadow-blue-500/10 flex items-center justify-center gap-2 uppercase tracking-wider"
                    >
                        <Save size={14} />
                        Создать прибор в проекте
                    </button>
                </div>
            </div>
        </div>
    );
};

export default FixtureConstructor;
