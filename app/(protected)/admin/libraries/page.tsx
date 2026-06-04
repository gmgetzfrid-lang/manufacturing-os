// "use client";

// import React, { useState, useEffect, useMemo } from 'react';
// import { useRouter } from 'next/navigation';
// import { 
//   collection, 
//   getDocs, 
//   addDoc, 
//   updateDoc, 
//   deleteDoc,
//   doc, 
//   serverTimestamp, 
//   query, 
//   orderBy,
//   where // Added for duplicate check
// } from 'firebase/firestore';
// import { db } from '@/lib/firebase';
// import { useRole } from '@/components/providers/RoleContext';
// import { LibraryConfig, LibraryType, Role } from '@/types/schema';
// import { 
//   Plus, 
//   Settings, 
//   Database, 
//   FileText, 
//   Briefcase, 
//   Users, 
//   Save, 
//   Trash2, 
//   CheckSquare, 
//   ToggleLeft, 
//   ToggleRight,
//   ChevronRight, 
//   Columns, 
//   Loader2, 
//   ShieldAlert, 
//   ArrowRight, 
//   CheckCircle2, 
//   Lock, 
//   Pencil, 
//   AlertTriangle,
//   X,
//   Search,
//   EyeOff,
//   FolderLock,
//   ArrowUp,
//   ArrowDown
// } from 'lucide-react';

// // =========================================================================================
// // SECTION 1: CONFIGURATION CONSTANTS & TYPES
// // =========================================================================================

// const LIBRARY_TYPES: { type: LibraryType; label: string; icon: any; desc: string; color: string; ringColor: string; bgColor: string }[] = [
//   { 
//     type: 'Engineering', 
//     label: 'Engineering / Technical', 
//     icon: Database, 
//     desc: 'Optimized for P&IDs, CAD drawings, and strict revision control sequences (A, B, 0, 1). Supports off-page connectors and smart tags.', 
//     color: 'text-blue-600',
//     ringColor: 'ring-blue-500',
//     bgColor: 'bg-blue-50'
//   },
//   { 
//     type: 'Procedure', 
//     label: 'Procedures & Policies', 
//     icon: FileText, 
//     desc: 'Includes periodic review cycles (1yr/3yr), training acknowledgement tracking, and expiration notifications.', 
//     color: 'text-teal-600',
//     ringColor: 'ring-teal-500',
//     bgColor: 'bg-teal-50'
//   },
//   { 
//     type: 'Business', 
//     label: 'General Business', 
//     icon: Briefcase, 
//     desc: 'Standard secure storage for HR, Finance, and Legal documents. Permissions are strictly enforced by department.', 
//     color: 'text-purple-600',
//     ringColor: 'ring-purple-500',
//     bgColor: 'bg-purple-50'
//   },
//   { 
//     type: 'UserSpace', 
//     label: 'User Workspaces', 
//     icon: Users, 
//     desc: 'Personal home drives and public shares for individual users. Quota managed.', 
//     color: 'text-slate-600',
//     ringColor: 'ring-slate-500',
//     bgColor: 'bg-slate-100'
//   },
// ];

// const DATA_TYPES = [
//   { value: 'text', label: 'Text String (Single Line)' },
//   { value: 'date', label: 'Date Picker' },
//   { value: 'user', label: 'User Selector (Directory)' },
//   { value: 'select', label: 'Dropdown List (Pre-defined)' },
//   { value: 'boolean', label: 'Checkbox (Yes/No)' },
//   { value: 'link', label: 'External URL / Link' },
// ];

// const ALL_ROLES: Role[] = [
//   'Requester', 'Drafter', 'Supervisor', 
//   'Engineer-1', 'Engineer-2', 'Engineer-3', 'Engineer-4', 
//   'DocCtrl', 'Admin', 'Manager', 
//   'HR', 'Safety', 'Accounting'
// ];

// // =========================================================================================
// // SECTION 2: DELETE SAFETY MODAL (GitHub Style)
// // =========================================================================================

// interface DeleteModalProps {
//   isOpen: boolean;
//   onClose: () => void;
//   onConfirm: () => Promise<void>;
//   libraryName: string;
//   isLoading: boolean;
// }

// const DeleteSafetyModal = ({ isOpen, onClose, onConfirm, libraryName, isLoading }: DeleteModalProps) => {
//   const [confirmText, setConfirmText] = useState('');

//   useEffect(() => {
//     if (isOpen) setConfirmText('');
//   }, [isOpen]);

//   if (!isOpen) return null;

//   const isMatch = confirmText === libraryName;

//   return (
//     <div className="fixed inset-0 z-[60] flex items-start sm:items-center justify-center overflow-y-auto p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200">
//       <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl overflow-hidden border-2 border-red-100">

//         {/* Header */}
//         <div className="px-6 py-4 bg-red-50 border-b border-red-100 flex items-center justify-between">
//           <h3 className="text-lg font-bold text-red-900 flex items-center">
//             <AlertTriangle className="w-5 h-5 mr-2 text-red-600" />
//             Delete Library?
//           </h3>
//           <button onClick={onClose} className="p-1 rounded-full hover:bg-red-100 text-red-400 hover:text-red-700 transition-colors">
//             <X className="w-5 h-5" />
//           </button>
//         </div>

//         {/* Body */}
//         <div className="p-6 space-y-4">
//           <p className="text-sm text-slate-600 leading-relaxed">
//             This action is <span className="font-bold text-red-600">irreversible</span>. 
//             This will permanently delete the <strong>{libraryName}</strong> library configuration. 
//             <br/><br/>
//             Documents inside this library may become orphaned or inaccessible if not migrated first.
//           </p>

//           <div className="space-y-2">
//             <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
//               Type <span className="select-all font-mono text-slate-800 bg-slate-100 px-1 py-0.5 rounded border border-slate-200">{libraryName}</span> to confirm:
//             </label>
//             <input 
//               type="text" 
//               value={confirmText}
//               onChange={(e) => setConfirmText(e.target.value)}
//               className="w-full p-3 border border-slate-300 rounded-lg text-sm font-bold focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none transition-all placeholder:font-normal"
//               placeholder="Type library name here..."
//               autoFocus
//             />
//           </div>
//         </div>

//         {/* Footer */}
//         <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex justify-end space-x-3">
//           <button 
//             onClick={onClose}
//             className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-white hover:text-slate-900 border border-transparent hover:border-slate-200 rounded-lg transition-all"
//             disabled={isLoading}
//           >
//             Cancel
//           </button>
//           <button 
//             onClick={onConfirm}
//             disabled={!isMatch || isLoading}
//             className="px-4 py-2 bg-red-600 text-white text-sm font-bold rounded-lg shadow-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center"
//           >
//             {isLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Trash2 className="w-4 h-4 mr-2" />}
//             I understand, delete this library
//           </button>
//         </div>
//       </div>
//     </div>
//   );
// };

// // =========================================================================================
// // SECTION 3: WIZARD MODAL (Create & Edit Logic)
// // =========================================================================================

// interface LibraryWizardProps {
//   isOpen: boolean;
//   onClose: () => void;
//   onSave: (config: Omit<LibraryConfig, 'id'>) => Promise<void>;
//   isLoading: boolean;
//   initialData?: LibraryConfig | null; 
// }

// const LibraryWizard = ({ isOpen, onClose, onSave, isLoading, initialData }: LibraryWizardProps) => {
//   const [step, setStep] = useState<1 | 2 | 3>(1);

//   // -- FORM STATE --
//   const [name, setName] = useState('');
//   const [description, setDescription] = useState('');
//   const [type, setType] = useState<LibraryType>('Engineering');

//   // Schema State
//   const [columns, setColumns] = useState<LibraryConfig['customColumns']>([]);

//   // Security State
//   const [writeAccess, setWriteAccess] = useState<Role[]>(['DocCtrl', 'Admin']);
//   const [readAccess, setReadAccess] = useState<Role[] | 'ALL'>('ALL');
//   const [adminAccess, setAdminAccess] = useState<Role[]>(['DocCtrl', 'Admin']);
//   const [folderSecurity, setFolderSecurity] = useState<'Inherited' | 'Granular'>('Inherited');

//   // Initialization Logic
//   useEffect(() => {
//     if (isOpen) {
//       setStep(1);
//       if (initialData) {
//         // EDIT MODE: Hydrate state
//         setName(initialData.name);
//         setDescription(initialData.description);
//         setType(initialData.type);
//         setColumns(initialData.customColumns || []);
//         setWriteAccess(initialData.writeAccess || []);
//         setReadAccess(initialData.readAccess || 'ALL');
//         setAdminAccess(initialData.adminAccess || []);
//         setFolderSecurity(initialData.folderSecurity || 'Inherited');
//       } else {
//         // CREATE MODE: Reset state
//         setName('');
//         setDescription('');
//         setType('Engineering');
//         setColumns([
//           { key: 'doc_no', label: 'Document No.', type: 'text', searchable: true, required: true },
//           { key: 'rev', label: 'Revision', type: 'text', searchable: true, required: true },
//           { key: 'title', label: 'Title', type: 'text', searchable: true, required: true },
//         ]);
//         setWriteAccess(['DocCtrl', 'Admin']);
//         setReadAccess('ALL');
//         setAdminAccess(['DocCtrl', 'Admin']);
//         setFolderSecurity('Inherited');
//       }
//     }
//   }, [isOpen, initialData]);

//   if (!isOpen) return null;

//   // -- LOGIC HANDLERS --

//   const handleNext = () => {
//     // Step 1 Validation
//     if (step === 1) {
//       if (!name.trim()) return alert("Library Name is required.");
//       if (!description.trim()) return alert("Description is required.");
//     }
//     // Step 2 Validation
//     if (step === 2) {
//        if (columns.some(c => !c.key || !c.label)) return alert("All columns must have a Label and Key.");
//     }

//     if (step < 3) setStep((prev) => (prev + 1) as any);
//   };

//   const handleBack = () => {
//     if (step > 1) setStep((prev) => (prev - 1) as any);
//   };

//   const handleAddColumn = () => {
//     setColumns([...columns, { key: '', label: '', type: 'text', searchable: true, required: false }]);
//   };

//   const handleRemoveColumn = (idx: number) => {
//     const newCols = [...columns];
//     newCols.splice(idx, 1);
//     setColumns(newCols);
//   };

//   // Reorder Logic
//   const handleMoveColumn = (idx: number, direction: 'up' | 'down') => {
//     if (direction === 'up' && idx === 0) return;
//     if (direction === 'down' && idx === columns.length - 1) return;

//     const newCols = [...columns];
//     const temp = newCols[idx];
//     if (direction === 'up') {
//       newCols[idx] = newCols[idx - 1];
//       newCols[idx - 1] = temp;
//     } else {
//       newCols[idx] = newCols[idx + 1];
//       newCols[idx + 1] = temp;
//     }
//     setColumns(newCols);
//   };

//   const updateColumn = (idx: number, field: keyof typeof columns[0], value: any) => {
//     const newCols = [...columns];
//     newCols[idx] = { ...newCols[idx], [field]: value };
//     // Smart Key Generation: Auto-fill key based on Label if key is empty
//     if (field === 'label' && !newCols[idx].key) {
//       newCols[idx].key = value.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
//     }
//     setColumns(newCols);
//   };

//   const toggleRole = (role: Role, list: Role[], setter: (r: Role[]) => void) => {
//     if (list.includes(role)) {
//       setter(list.filter(r => r !== role));
//     } else {
//       setter([...list, role]);
//     }
//   };

//   const handleSubmit = async () => {
//     // Final Validation
//     if (columns.some(c => !c.key || !c.label)) {
//       return alert("All columns must have a valid Label and Database Key.");
//     }

//     // Auto-calculate VisibleTo Array
//     let visibleTo: Role[] = [];
//     if (readAccess === 'ALL') {
//       visibleTo = ALL_ROLES;
//     } else {
//       const set = new Set([...adminAccess, ...writeAccess, ...(readAccess as Role[])]);
//       visibleTo = Array.from(set);
//     }

//     await onSave({
//       name,
//       description,
//       type,
//       customColumns: columns.filter(c => c.key && c.label),
//       writeAccess,
//       readAccess,
//       adminAccess,
//       visibleTo,
//       folderSecurity
//     });
//   };

//   // Helper to calculate "Ghost Mode" list (Who is blocked)
//   const getBlockedRoles = () => {
//     if (readAccess === 'ALL') return [];
//     const allowed = new Set([...adminAccess, ...writeAccess, ...(readAccess as Role[])]);
//     return ALL_ROLES.filter(r => !allowed.has(r));
//   };
//   const blockedRoles = getBlockedRoles();

//   return (
//     <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center overflow-y-auto bg-slate-900/80 backdrop-blur-sm p-4 animate-in fade-in">
//       <div className="bg-white w-full max-w-5xl h-[90vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-slate-200">

//         {/* HEADER */}
//         <div className="px-8 py-6 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
//           <div>
//             <h2 className="text-2xl font-bold text-slate-900">{initialData ? 'Edit Configuration' : 'New Library Wizard'}</h2>
//             <p className="text-slate-500 text-sm mt-1">
//               Step {step} of 3: <span className="font-semibold text-slate-700">{step === 1 ? 'Identity & Archetype' : step === 2 ? 'Metadata Schema' : 'Access Control'}</span>
//             </p>
//           </div>

//           {/* STEPPER UI */}
//           <div className="flex items-center space-x-2">
//             {[1, 2, 3].map((s) => (
//               <React.Fragment key={s}>
//                 <div 
//                   className={`flex items-center justify-center w-8 h-8 rounded-full font-bold text-xs transition-all duration-300 ${
//                     step >= s ? 'bg-orange-600 text-white scale-110' : 'bg-slate-200 text-slate-500'
//                   }`}
//                 >
//                   {step > s ? <CheckCircle2 className="w-5 h-5" /> : s}
//                 </div>
//                 {s < 3 && <div className={`w-8 h-1 transition-all duration-500 ${step > s ? 'bg-orange-600' : 'bg-slate-200'}`} />}
//               </React.Fragment>
//             ))}
//           </div>
//         </div>

//         {/* BODY CONTENT AREA */}
//         <div className="flex-1 overflow-y-auto p-8 bg-white relative">

//           {/* --- STEP 1: IDENTITY --- */}
//           {step === 1 && (
//             <div className="space-y-8 animate-in fade-in slide-in-from-right-8 duration-300">
//               <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
//                 <div className="space-y-6">
//                   <div>
//                     <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Library Name <span className="text-red-500">*</span></label>
//                     <input 
//                       value={name}
//                       onChange={(e) => setName(e.target.value)}
//                       placeholder="e.g. Bakersfield P&IDs"
//                       className="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl text-lg font-bold text-slate-900 focus:ring-2 focus:ring-orange-500 outline-none transition-all placeholder:text-slate-300"
//                       autoFocus
//                     />
//                   </div>
//                   <div>
//                     <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Description <span className="text-red-500">*</span></label>
//                     <textarea 
//                       value={description}
//                       onChange={(e) => setDescription(e.target.value)}
//                       placeholder="What is stored here? Who is it for?"
//                       rows={5}
//                       className="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium text-slate-700 focus:ring-2 focus:ring-orange-500 outline-none resize-none transition-all"
//                     />
//                   </div>
//                 </div>

//                 <div>
//                   <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-4">Select Archetype</label>
//                   <div className="space-y-3">
//                     {LIBRARY_TYPES.map((t) => (
//                       <div 
//                         key={t.type}
//                         onClick={() => setType(t.type)}
//                         className={`p-4 rounded-xl border-2 cursor-pointer transition-all flex items-start space-x-4 ${type === t.type ? `border-orange-500 bg-orange-50 ring-1 ring-orange-500` : 'border-slate-100 hover:border-slate-300 hover:bg-slate-50'}`}
//                       >
//                         <div className={`p-2.5 rounded-lg shrink-0 ${type === t.type ? 'bg-white shadow-sm' : 'bg-slate-100'}`}>
//                           <t.icon className={`w-6 h-6 ${type === t.type ? t.color : 'text-slate-400'}`} />
//                         </div>
//                         <div className="flex-1">
//                           <h4 className={`font-bold text-sm ${type === t.type ? 'text-slate-900' : 'text-slate-600'}`}>{t.label}</h4>
//                           <p className="text-xs text-slate-500 mt-1 leading-relaxed">{t.desc}</p>
//                         </div>
//                         {type === t.type && <div className="bg-orange-600 rounded-full p-1"><CheckCircle2 className="w-4 h-4 text-white" /></div>}
//                       </div>
//                     ))}
//                   </div>
//                 </div>
//               </div>
//             </div>
//           )}

//           {/* --- STEP 2: METADATA --- */}
//           {step === 2 && (
//             <div className="space-y-6 animate-in fade-in slide-in-from-right-8 duration-300">
//               <div className="bg-blue-50 border border-blue-100 p-6 rounded-xl flex items-start">
//                 <Columns className="w-8 h-8 text-blue-600 mr-4 shrink-0" />
//                 <div>
//                   <h4 className="text-lg font-bold text-blue-900">Dynamic Metadata Definition</h4>
//                   <p className="text-sm text-blue-700 mt-1 max-w-2xl">
//                     Define the "Smart Headers" for this library. These columns determine how documents are indexed, searched, and filtered.
//                   </p>
//                 </div>
//               </div>

//               <div className="border border-slate-200 rounded-xl overflow-hidden shadow-sm">
//                 <table className="w-full">
//                   <thead className="bg-slate-50 border-b border-slate-200">
//                     <tr>
//                       <th className="w-16"></th>
//                       <th className="text-left text-xs font-bold text-slate-500 uppercase py-3 pl-4 w-1/4">Column Label</th>
//                       <th className="text-left text-xs font-bold text-slate-500 uppercase py-3 w-1/4">Database Key</th>
//                       <th className="text-left text-xs font-bold text-slate-500 uppercase py-3 w-1/6">Data Type</th>
//                       <th className="text-center text-xs font-bold text-slate-500 uppercase py-3 w-1/12">Searchable</th>
//                       <th className="text-center text-xs font-bold text-slate-500 uppercase py-3 w-1/12">Required</th>
//                       <th className="w-16"></th>
//                     </tr>
//                   </thead>
//                   <tbody className="divide-y divide-slate-100 bg-white">
//                     {columns.map((col, idx) => (
//                       <tr key={idx} className="group hover:bg-slate-50 transition-colors">
//                          {/* Reorder Buttons */}
//                         <td className="p-2 text-center">
//                           <div className="flex flex-col items-center">
//                             <button onClick={() => handleMoveColumn(idx, 'up')} disabled={idx === 0} className="text-slate-300 hover:text-slate-600 disabled:opacity-0 mb-1"><ArrowUp className="w-3 h-3" /></button>
//                             <button onClick={() => handleMoveColumn(idx, 'down')} disabled={idx === columns.length - 1} className="text-slate-300 hover:text-slate-600 disabled:opacity-0"><ArrowDown className="w-3 h-3" /></button>
//                           </div>
//                         </td>
//                         <td className="p-2 pl-4">
//                           <input 
//                             value={col.label} 
//                             onChange={(e) => updateColumn(idx, 'label', e.target.value)}
//                             placeholder="Display Name"
//                             className="w-full p-2.5 bg-white border border-slate-200 rounded-lg text-sm font-bold focus:ring-2 focus:ring-orange-500 outline-none transition-all focus:border-transparent"
//                           />
//                         </td>
//                         <td className="p-2">
//                           <input 
//                             value={col.key} 
//                             onChange={(e) => updateColumn(idx, 'key', e.target.value)}
//                             placeholder="db_key_internal"
//                             className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm font-mono text-slate-600 focus:ring-2 focus:ring-orange-500 outline-none transition-all"
//                           />
//                         </td>
//                         <td className="p-2">
//                           <select 
//                             value={col.type}
//                             onChange={(e) => updateColumn(idx, 'type', e.target.value)}
//                             className="w-full p-2.5 bg-white border border-slate-200 rounded-lg text-sm font-medium focus:ring-2 focus:ring-orange-500 outline-none cursor-pointer"
//                           >
//                             {DATA_TYPES.map(dt => <option key={dt.value} value={dt.value}>{dt.label}</option>)}
//                           </select>
//                         </td>
//                         <td className="p-2 text-center">
//                           <button onClick={() => updateColumn(idx, 'searchable', !col.searchable)} className="hover:scale-110 transition-transform active:scale-95">
//                             {col.searchable ? <ToggleRight className="w-8 h-8 text-green-500 mx-auto" /> : <ToggleLeft className="w-8 h-8 text-slate-300 mx-auto" />}
//                           </button>
//                         </td>
//                         <td className="p-2 text-center">
//                           <button onClick={() => updateColumn(idx, 'required', !col.required)} className="hover:scale-110 transition-transform active:scale-95">
//                             {col.required ? <CheckSquare className="w-6 h-6 text-orange-600 mx-auto" /> : <div className="w-6 h-6 border-2 border-slate-300 rounded mx-auto" />}
//                           </button>
//                         </td>
//                         <td className="p-2 text-center">
//                           <button onClick={() => handleRemoveColumn(idx)} className="p-2 text-slate-300 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all">
//                             <Trash2 className="w-5 h-5" />
//                           </button>
//                         </td>
//                       </tr>
//                     ))}
//                   </tbody>
//                 </table>
//               </div>

//               <button 
//                 onClick={handleAddColumn}
//                 className="w-full py-4 border-2 border-dashed border-slate-300 rounded-xl text-slate-500 font-bold hover:border-orange-400 hover:text-orange-600 hover:bg-orange-50 transition-all flex items-center justify-center group"
//               >
//                 <Plus className="w-5 h-5 mr-2 group-hover:scale-110 transition-transform" /> Add Metadata Column
//               </button>
//             </div>
//           )}

//           {/* --- STEP 3: SECURITY --- */}
//           {step === 3 && (
//             <div className="space-y-8 animate-in fade-in slide-in-from-right-8 duration-300">

//               {/* Folder Strategy */}
//               <div className="bg-slate-50 p-6 rounded-xl border border-slate-200 flex items-center justify-between">
//                 <div>
//                    <h4 className="font-bold text-slate-900 text-sm flex items-center"><FolderLock className="w-4 h-4 mr-2" /> Collection Security Strategy</h4>
//                    <p className="text-xs text-slate-500 mt-1">How should permissions apply to sub-folders created inside this library?</p>
//                 </div>
//                 <div className="flex bg-white rounded-lg border border-slate-300 p-1">
//                   <button onClick={() => setFolderSecurity('Inherited')} className={`px-4 py-2 rounded text-xs font-bold transition-all ${folderSecurity === 'Inherited' ? 'bg-slate-800 text-white shadow' : 'text-slate-500 hover:text-slate-800'}`}>Inherited (Simple)</button>
//                   <button onClick={() => setFolderSecurity('Granular')} className={`px-4 py-2 rounded text-xs font-bold transition-all ${folderSecurity === 'Granular' ? 'bg-slate-800 text-white shadow' : 'text-slate-500 hover:text-slate-800'}`}>Granular (Advanced)</button>
//                 </div>
//               </div>

//               {/* Invisibility Warning (The "Ghost Mode" Feedback) */}
//               {blockedRoles.length > 0 && (
//                 <div className="bg-amber-50 border border-amber-200 p-4 rounded-xl flex items-start">
//                   <EyeOff className="w-5 h-5 text-amber-600 mr-3 shrink-0 mt-0.5" />
//                   <div>
//                     <h4 className="text-sm font-bold text-amber-900">Ghost Mode Active</h4>
//                     <p className="text-xs text-amber-800 mt-1 leading-relaxed">
//                       Based on your current settings, this library will be <strong>completely invisible</strong> to the following roles:
//                     </p>
//                     <div className="flex flex-wrap gap-2 mt-2">
//                       {blockedRoles.map(r => (
//                         <span key={r} className="px-2 py-0.5 bg-white border border-amber-200 rounded text-[10px] font-bold text-amber-700">{r}</span>
//                       ))}
//                     </div>
//                   </div>
//                 </div>
//               )}

//               {/* Role Matrix */}
//               <div className="border border-slate-200 rounded-xl overflow-hidden shadow-sm">
//                 <div className="bg-slate-100 px-8 py-4 border-b border-slate-200 grid grid-cols-4 gap-4 font-bold text-xs text-slate-500 uppercase tracking-wider">
//                   <div>Role / Group</div>
//                   <div className="text-center">Admin Rights</div>
//                   <div className="text-center">Write Rights</div>
//                   <div className="text-center">Read Rights</div>
//                 </div>
//                 <div className="divide-y divide-slate-100 max-h-[350px] overflow-y-auto bg-white custom-scrollbar">
//                   {ALL_ROLES.map(role => (
//                     <div key={role} className="px-8 py-4 grid grid-cols-4 gap-4 items-center hover:bg-slate-50 transition-colors">
//                       <div className="font-bold text-sm text-slate-700">{role}</div>

//                       {/* Admin Toggle */}
//                       <div className="flex justify-center">
//                         <div 
//                           onClick={() => toggleRole(role, adminAccess, setAdminAccess)}
//                           className={`w-6 h-6 rounded border cursor-pointer flex items-center justify-center transition-colors shadow-sm ${adminAccess.includes(role) ? 'bg-purple-600 border-purple-600 text-white scale-110' : 'border-slate-300 bg-white hover:border-purple-400'}`}
//                         >
//                            {adminAccess.includes(role) && <CheckSquare className="w-4 h-4" />}
//                         </div>
//                       </div>

//                       {/* Write Toggle */}
//                       <div className="flex justify-center">
//                         <div 
//                           onClick={() => !adminAccess.includes(role) && toggleRole(role, writeAccess, setWriteAccess)}
//                           className={`w-6 h-6 rounded border flex items-center justify-center transition-colors shadow-sm ${adminAccess.includes(role) ? 'bg-slate-100 border-slate-200 cursor-not-allowed opacity-50' : 'cursor-pointer border-slate-300 hover:border-blue-400'} ${(writeAccess.includes(role) || adminAccess.includes(role)) && !adminAccess.includes(role) ? 'bg-blue-600 border-blue-600 text-white scale-110' : 'bg-white'}`}
//                         >
//                            {(writeAccess.includes(role) || adminAccess.includes(role)) && <CheckSquare className={`w-4 h-4 ${adminAccess.includes(role) ? 'text-slate-400' : 'text-white'}`} />}
//                         </div>
//                       </div>

//                       {/* Read Toggle */}
//                       <div className="flex justify-center">
//                          {readAccess === 'ALL' ? (
//                            <div className="w-6 h-6 rounded border border-slate-200 bg-slate-100 flex items-center justify-center cursor-help" title="Read is set to ALL"><CheckSquare className="w-4 h-4 text-slate-400" /></div>
//                          ) : (
//                            <div 
//                               onClick={() => {
//                                 // Logic: Admin/Write imply Read. Can only toggle off if not admin/write.
//                                 if (adminAccess.includes(role) || writeAccess.includes(role)) return;
//                                 toggleRole(role, readAccess as Role[], setReadAccess);
//                               }}
//                               className={`w-6 h-6 rounded border flex items-center justify-center transition-colors shadow-sm ${adminAccess.includes(role) || writeAccess.includes(role) ? 'bg-slate-100 border-slate-200 opacity-50 cursor-not-allowed' : 'cursor-pointer border-slate-300 hover:border-green-400'} ${(readAccess as Role[]).includes(role) || adminAccess.includes(role) || writeAccess.includes(role) ? 'bg-green-600 border-green-600 text-white scale-110' : 'bg-white'}`}
//                            >
//                               {((readAccess as Role[]).includes(role) || adminAccess.includes(role) || writeAccess.includes(role)) && <CheckSquare className="w-4 h-4" />}
//                            </div>
//                          )}
//                       </div>
//                     </div>
//                   ))}
//                 </div>
//                 {/* Toggle for Public Read */}
//                 <div className="px-8 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
//                    <span className="text-xs font-bold text-slate-500">Allow Global Read Access?</span>
//                    <button 
//                      onClick={() => setReadAccess(readAccess === 'ALL' ? [] : 'ALL')}
//                      className={`px-3 py-1 rounded text-xs font-bold transition-colors ${readAccess === 'ALL' ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-500'}`}
//                    >
//                      {readAccess === 'ALL' ? 'Yes (Public)' : 'No (Restricted)'}
//                    </button>
//                 </div>
//               </div>
//             </div>
//           )}

//         </div>

//         {/* FOOTER */}
//         <div className="px-8 py-6 border-t border-slate-200 bg-slate-50 flex justify-between items-center">
//            <button 
//              onClick={handleBack} 
//              disabled={step === 1}
//              className="px-6 py-3 text-sm font-bold text-slate-500 hover:text-slate-800 disabled:opacity-30 disabled:hover:text-slate-500 transition-colors"
//            >
//              Back
//            </button>

//            <div className="flex space-x-4">
//              <button onClick={onClose} className="px-6 py-3 text-sm font-bold text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-xl transition-colors">Cancel & Exit</button>

//              {step < 3 ? (
//                <button 
//                  onClick={handleNext}
//                  className="px-8 py-3 bg-slate-900 text-white text-sm font-bold rounded-xl shadow-lg hover:bg-slate-800 transition-all flex items-center hover:scale-105 active:scale-95"
//                >
//                  Next Step <ArrowRight className="w-4 h-4 ml-2" />
//                </button>
//              ) : (
//                <button 
//                  onClick={handleSubmit} 
//                  disabled={isLoading}
//                  className="px-8 py-3 bg-orange-600 text-white text-sm font-bold rounded-xl shadow-xl shadow-orange-900/20 hover:bg-orange-700 hover:scale-105 transition-all flex items-center"
//                >
//                  {isLoading ? <span className="flex items-center"><Loader2 className="w-4 h-4 mr-2 animate-spin"/>Processing...</span> : <><Save className="w-4 h-4 mr-2" /> {initialData ? 'Save Changes' : 'Create Library'}</>}
//                </button>
//              )}
//            </div>
//         </div>
//       </div>
//     </div>
//   );
// };

// // =========================================================================================
// // MAIN PAGE COMPONENT: LIBRARY COMMAND CENTER
// // =========================================================================================

// export default function LibraryAdmin() {
//   const router = useRouter();
//   const { activeRole } = useRole();

//   const [libraries, setLibraries] = useState<LibraryConfig[]>([]);
//   const [loading, setLoading] = useState(true);
//   const [isModalOpen, setIsModalOpen] = useState(false);
//   const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
//   const [libraryToDelete, setLibraryToDelete] = useState<LibraryConfig | null>(null);

//   const [saving, setSaving] = useState(false);
//   const [deleting, setDeleting] = useState(false);
//   const [editingLib, setEditingLib] = useState<LibraryConfig | null>(null);
//   const [searchTerm, setSearchTerm] = useState('');
//   const [sortOrder, setSortOrder] = useState<'name' | 'recent'>('recent');

//   // --- 1. SECURITY GUARD ---
//   useEffect(() => {
//     if (activeRole && !['Admin', 'DocCtrl'].includes(activeRole)) {
//       router.push('/dashboard');
//     }
//   }, [activeRole, router]);

//   // --- 2. FETCH LIBRARIES ---
//   useEffect(() => {
//     const fetchLibs = async () => {
//       try {
//         const q = query(collection(db, 'libraries'), orderBy('createdAt', 'desc'));
//         const snap = await getDocs(q);
//         const libs = snap.docs.map(d => ({ id: d.id, ...d.data() } as LibraryConfig));
//         setLibraries(libs);
//         setLoading(false);
//       } catch (err) {
//         console.error("Error fetching libraries:", err);
//         setLoading(false);
//       }
//     };
//     fetchLibs();
//   }, []);

//   // --- 3. SAVE HANDLER (Create/Update with Duplicate Check) ---
//   const handleSaveLibrary = async (config: Omit<LibraryConfig, 'id'>) => {
//     setSaving(true);
//     try {
//       // VALIDATION: Check for Duplicate Names
//       const exists = libraries.find(l => 
//         l.name.toLowerCase().trim() === config.name.toLowerCase().trim() && 
//         l.id !== editingLib?.id // Ignore self if editing
//       );

//       if (exists) {
//         alert("A Library with this name already exists. Please choose a unique name.");
//         setSaving(false);
//         return;
//       }

//       if (editingLib) {
//         // UPDATE
//         await updateDoc(doc(db, 'libraries', editingLib.id), { ...config });
//         setLibraries(libraries.map(l => l.id === editingLib.id ? { ...l, ...config } : l));
//       } else {
//         // CREATE
//         const docRef = await addDoc(collection(db, 'libraries'), {
//           ...config,
//           createdAt: serverTimestamp()
//         });
//         setLibraries([{ id: docRef.id, ...config } as LibraryConfig, ...libraries]);
//       }
//       setIsModalOpen(false);
//       setEditingLib(null);
//     } catch (err) {
//       console.error("Failed to save library", err);
//       alert("Error saving library. Please check your permissions.");
//     } finally {
//       setSaving(false);
//     }
//   };

//   // --- 4. DELETE HANDLER ---
//   const initiateDelete = (lib: LibraryConfig) => {
//     setLibraryToDelete(lib);
//     setIsDeleteModalOpen(true);
//   };

//   const confirmDelete = async () => {
//     if (!libraryToDelete) return;
//     setDeleting(true);
//     try {
//       await deleteDoc(doc(db, 'libraries', libraryToDelete.id));
//       setLibraries(libraries.filter(l => l.id !== libraryToDelete.id));
//       setIsDeleteModalOpen(false);
//       setLibraryToDelete(null);
//     } catch (e) {
//       console.error(e);
//       alert("Failed to delete library.");
//     } finally {
//       setDeleting(false);
//     }
//   };

//   const openCreate = () => { setEditingLib(null); setIsModalOpen(true); };
//   const openEdit = (lib: LibraryConfig) => { setEditingLib(lib); setIsModalOpen(true); };

//   // --- 5. FILTER & SORT LOGIC ---
//   const filteredLibraries = useMemo(() => {
//     let filtered = libraries.filter(l => l.name.toLowerCase().includes(searchTerm.toLowerCase()) || l.description.toLowerCase().includes(searchTerm.toLowerCase()));
//     if (sortOrder === 'name') {
//       filtered.sort((a, b) => a.name.localeCompare(b.name));
//     }
//     // 'recent' is default from DB query
//     return filtered;
//   }, [libraries, searchTerm, sortOrder]);

//   if (!['Admin', 'DocCtrl'].includes(activeRole)) return null;

//   return (
//     <div className="min-h-screen bg-slate-50 p-8 pb-20">

//       {/* MODALS */}
//       <LibraryWizard 
//         isOpen={isModalOpen} 
//         onClose={() => setIsModalOpen(false)} 
//         onSave={handleSaveLibrary} 
//         isLoading={saving} 
//         initialData={editingLib} 
//       />

//       {libraryToDelete && (
//         <DeleteSafetyModal 
//           isOpen={isDeleteModalOpen}
//           onClose={() => setIsDeleteModalOpen(false)}
//           onConfirm={confirmDelete}
//           libraryName={libraryToDelete.name}
//           isLoading={deleting}
//         />
//       )}

//       <div className="max-w-7xl mx-auto">

//         {/* DASHBOARD HEADER */}
//         <div className="flex flex-col md:flex-row justify-between items-end mb-10 gap-4">
//           <div>
//             <div className="flex items-center space-x-3 mb-2">
//               <div className="p-3 bg-slate-900 rounded-xl shadow-lg shadow-slate-900/20">
//                 <Settings className="w-6 h-6 text-white" />
//               </div>
//               <h1 className="text-3xl font-black text-slate-900 tracking-tight">Library Administration</h1>
//             </div>
//             <p className="text-slate-500 font-medium max-w-xl text-sm leading-relaxed">
//               Configure document repositories, define dynamic metadata schemas, and manage global access control policies for the entire organization.
//             </p>
//           </div>
//           <button 
//             onClick={openCreate}
//             className="px-6 py-4 bg-orange-600 text-white font-bold rounded-xl shadow-xl shadow-orange-900/20 hover:bg-orange-700 hover:scale-105 transition-all flex items-center whitespace-nowrap active:scale-95"
//           >
//             <Plus className="w-5 h-5 mr-2" /> New Library
//           </button>
//         </div>

//         {/* SEARCH & FILTER BAR */}
//         <div className="flex flex-col sm:flex-row gap-4 mb-8">
//            <div className="relative flex-1">
//              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
//              <input 
//                type="text" 
//                placeholder="Search libraries by name or description..." 
//                value={searchTerm}
//                onChange={(e) => setSearchTerm(e.target.value)}
//                className="w-full pl-12 pr-4 py-3 bg-white border border-slate-200 rounded-xl text-sm font-medium focus:ring-2 focus:ring-orange-500 outline-none shadow-sm"
//              />
//            </div>
//            <div className="flex items-center space-x-2 bg-white p-1 rounded-xl border border-slate-200 shadow-sm">
//              <button onClick={() => setSortOrder('recent')} className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${sortOrder === 'recent' ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>Newest</button>
//              <button onClick={() => setSortOrder('name')} className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${sortOrder === 'name' ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>A-Z</button>
//            </div>
//         </div>

//         {/* LIBRARY GRID */}
//         {loading ? (
//           <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
//             {[1, 2, 3].map(i => <div key={i} className="h-80 bg-white rounded-3xl border border-slate-200 animate-pulse shadow-sm" />)}
//           </div>
//         ) : filteredLibraries.length === 0 ? (
//           <div className="text-center py-32 bg-white rounded-[2.5rem] border-2 border-dashed border-slate-200 shadow-sm">
//             <div className="w-24 h-24 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-6 text-slate-300">
//               <Database className="w-12 h-12" />
//             </div>
//             <h3 className="text-2xl font-bold text-slate-900 mb-3">{libraries.length === 0 ? "System Uninitialized" : "No Matches Found"}</h3>
//             <p className="text-slate-500 max-w-md mx-auto mb-8 leading-relaxed">
//               {libraries.length === 0 ? "ManufacturingOS requires at least one Document Library to function." : "Adjust your search terms to find the library you are looking for."}
//             </p>
//             {libraries.length === 0 && <button onClick={openCreate} className="text-orange-600 font-bold hover:underline text-lg">Initialize First Library</button>}
//           </div>
//         ) : (
//           <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
//             {filteredLibraries.map(lib => {
//                const archetype = LIBRARY_TYPES.find(t => t.type === lib.type) || LIBRARY_TYPES[0];
//                const Icon = archetype.icon;
//                // Ghost Mode Check: If Read Access is RESTRICTED (not ALL) AND visibility list is a subset
//                const isGhost = lib.readAccess !== 'ALL' && lib.visibleTo && lib.visibleTo.length < ALL_ROLES.length;

//                return (
//                  <div key={lib.id} className="bg-white rounded-3xl border border-slate-200 shadow-sm hover:shadow-2xl hover:border-orange-200 transition-all duration-300 group flex flex-col relative overflow-hidden h-full">
//                     {/* Top Stripe */}
//                     <div className={`absolute top-0 left-0 right-0 h-2 bg-${archetype.color.replace('text-', '')}-500`} />

//                     <div className="p-8 pb-6 flex-1">
//                       <div className="flex justify-between items-start mb-6">
//                         <div className={`p-4 rounded-2xl ${archetype.bgColor} ${archetype.color}`}>
//                           <Icon className="w-8 h-8" />
//                         </div>
//                         {/* Status Badges */}
//                         <div className="flex flex-col items-end space-y-2">
//                            <span className="px-3 py-1 bg-green-100 text-green-700 text-[10px] font-bold uppercase tracking-wider rounded-full border border-green-200">Active</span>
//                            {isGhost && (
//                              <div className="flex items-center px-2 py-1 bg-amber-50 text-amber-700 text-[10px] font-bold uppercase tracking-wider rounded border border-amber-200" title="Visible only to specific roles">
//                                <EyeOff className="w-3 h-3 mr-1" /> Ghost
//                              </div>
//                            )}
//                            {lib.folderSecurity === 'Granular' && (
//                              <div className="flex items-center px-2 py-1 bg-purple-50 text-purple-700 text-[10px] font-bold uppercase tracking-wider rounded border border-purple-200" title="Sub-folder permissions enabled">
//                                <FolderLock className="w-3 h-3 mr-1" /> Secure
//                              </div>
//                            )}
//                         </div>
//                       </div>

//                       <h3 className="text-2xl font-bold text-slate-900 mb-3 tracking-tight">{lib.name}</h3>
//                       <p className="text-sm text-slate-500 leading-relaxed mb-4 line-clamp-3">{lib.description}</p>
//                     </div>

//                     {/* Info Bar */}
//                     <div className="px-8 py-4 bg-slate-50 border-t border-b border-slate-100 space-y-3">
//                       <div className="flex justify-between text-xs items-center">
//                         <span className="font-bold text-slate-400 uppercase flex items-center"><Columns className="w-3 h-3 mr-1.5" /> Schema</span>
//                         <span className="font-bold text-slate-700 bg-white border border-slate-200 px-2 py-0.5 rounded shadow-sm">{lib.customColumns?.length || 0} Fields</span>
//                       </div>
//                       <div className="flex justify-between text-xs items-center">
//                         <span className="font-bold text-slate-400 uppercase flex items-center"><Lock className="w-3 h-3 mr-1.5" /> Security</span>
//                         <span className="font-bold text-slate-700 bg-white border border-slate-200 px-2 py-0.5 rounded shadow-sm">{lib.adminAccess?.length} Admins</span>
//                       </div>
//                     </div>

//                     {/* Action Bar */}
//                     <div className="p-4 grid grid-cols-2 gap-3 bg-white">
//                       <button 
//                         onClick={() => openEdit(lib)}
//                         className="flex items-center justify-center py-2.5 rounded-xl text-sm font-bold text-slate-600 bg-slate-50 hover:bg-slate-100 border border-slate-200 transition-colors"
//                       >
//                         <Pencil className="w-4 h-4 mr-2" /> Edit Config
//                       </button>
//                       <button 
//                         onClick={() => initiateDelete(lib)}
//                         className="flex items-center justify-center py-2.5 rounded-xl text-sm font-bold text-red-600 bg-red-50 hover:bg-red-100 border border-red-100 transition-colors"
//                       >
//                         <Trash2 className="w-4 h-4 mr-2" /> Delete
//                       </button>
//                     </div>
//                  </div>
//                );
//             })}
//           </div>
//         )}
//       </div>
//     </div>
//   );
// }

"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { Settings } from "lucide-react";
import LibraryWizard from "./LibraryWizard";
import DeleteSafetyModal from "./DeleteSafetyModal";
import { LibraryConfig } from "@/types/schema";

export default function LibraryAdminPage() {
  const router = useRouter();
  const { activeRole, activeOrgId, uid } = useRole();

  const [loading, setLoading] = useState(true);
  const [libraries, setLibraries] = useState<LibraryConfig[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingLib, setEditingLib] = useState<LibraryConfig | null>(null);

  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [libraryToDelete, setLibraryToDelete] = useState<LibraryConfig | null>(null);

  const [searchTerm, setSearchTerm] = useState("");
  const [sortOrder, setSortOrder] = useState<"name" | "recent">("recent");

  const isController = activeRole === "Admin" || activeRole === "DocCtrl";

  // Guard
  useEffect(() => {
    if (activeRole && !isController) router.push("/dashboard");
  }, [activeRole, isController, router]);

  // Fetch org-scoped libraries
  useEffect(() => {
    const run = async () => {
      if (!activeOrgId) {
        setLibraries([]);
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        const { data, error } = await supabase
          .from("libraries")
          .select("*")
          .eq("org_id", activeOrgId)
          .order("created_at", { ascending: false });
        if (error) throw error;
        const libs = (data || []).map(r => ({
          id: r.id, orgId: r.org_id, name: r.name, type: r.type,
          description: r.description, createdAt: r.created_at, createdBy: r.created_by,
          updatedAt: r.updated_at, updatedBy: r.updated_by,
          customColumns: r.custom_columns ?? [],
          writeAccess: r.write_access ?? [], adminAccess: r.admin_access ?? [],
          readAccess: r.read_access ?? "ALL", visibleTo: r.visible_to ?? [],
          folderSecurity: r.folder_security, defaultNewVisibility: r.default_new_visibility,
          defaultNewAcl: r.default_new_acl, acl: r.acl,
        } as LibraryConfig));
        setLibraries(libs);
      } catch (err) {
        console.error("Error fetching libraries:", err);
        setLibraries([]);
      } finally {
        setLoading(false);
      }
    };

    run();
  }, [activeOrgId]);

  const handleSaveLibrary = async (config: Omit<LibraryConfig, "id">) => {
    if (!activeOrgId) {
      alert("No active org selected. Set an orgId first.");
      return;
    }
    if (!uid) {
      alert("Not authenticated.");
      return;
    }

    setSaving(true);
    try {
      // Duplicate name guard within org
      const exists = libraries.find(
        (l) =>
          (l.name || "").toLowerCase().trim() === (config.name || "").toLowerCase().trim() &&
          l.id !== editingLib?.id
      );
      if (exists) {
        alert("A Library with this name already exists. Please choose a unique name.");
        setSaving(false);
        return;
      }

      const now = new Date().toISOString();
      const dbConfig = {
        name: config.name, type: config.type, description: config.description,
        custom_columns: config.customColumns ?? [],
        write_access: config.writeAccess ?? [], admin_access: config.adminAccess ?? [],
        read_access: config.readAccess ?? "ALL", visible_to: config.visibleTo ?? [],
        folder_security: config.folderSecurity, default_new_visibility: config.defaultNewVisibility,
        default_new_acl: config.defaultNewAcl ?? null, acl: config.acl ?? null,
      };

      if (editingLib) {
        const { error } = await supabase
          .from("libraries")
          .update({ ...dbConfig, updated_at: now, updated_by: uid })
          .eq("id", editingLib.id!);
        if (error) throw error;

        setLibraries((prev) =>
          prev.map((l) => l.id === editingLib.id ? ({ ...l, ...config, orgId: l.orgId ?? activeOrgId } as LibraryConfig) : l)
        );
      } else {
        const { data: newLib, error } = await supabase
          .from("libraries")
          .insert({ ...dbConfig, org_id: activeOrgId, created_at: now, created_by: uid, updated_at: now, updated_by: uid })
          .select("id")
          .single();
        if (error || !newLib) throw error ?? new Error("Failed to create library");

        setLibraries((prev) => [{ id: newLib.id, ...config, orgId: activeOrgId } as LibraryConfig, ...prev]);
      }

      setIsModalOpen(false);
      setEditingLib(null);
    } catch (err) {
      console.error("Failed to save library", err);
      alert("Error saving library. Please check your permissions.");
    } finally {
      setSaving(false);
    }
  };

  const initiateDelete = (lib: LibraryConfig) => {
    setLibraryToDelete(lib);
    setIsDeleteModalOpen(true);
  };

  const confirmDelete = async () => {
    if (!libraryToDelete) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from("libraries").delete().eq("id", libraryToDelete.id!);
      if (error) throw error;
      setLibraries((prev) => prev.filter((l) => l.id !== libraryToDelete.id));
      setIsDeleteModalOpen(false);
      setLibraryToDelete(null);
    } catch (e) {
      console.error(e);
      alert("Failed to delete library.");
    } finally {
      setDeleting(false);
    }
  };

  const openCreate = () => {
    setEditingLib(null);
    setIsModalOpen(true);
  };

  const openEdit = (lib: LibraryConfig) => {
    setEditingLib(lib);
    setIsModalOpen(true);
  };

  const filteredLibraries = useMemo(() => {
    const filtered = libraries.filter((l) => {
      const hay = `${l.name || ""} ${l.description || ""}`.toLowerCase();
      return hay.includes(searchTerm.toLowerCase());
    });

    if (sortOrder === "name") {
      filtered.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    }

    return filtered;
  }, [libraries, searchTerm, sortOrder]);

  if (!isController) return null;

  if (!activeOrgId) {
    return (
      <div className="min-h-screen bg-slate-50 p-8">
        <div className="max-w-3xl mx-auto bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-slate-900 rounded-xl shadow-lg shadow-slate-900/20">
              <Settings className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-black text-slate-900">Library Administration</h1>
              <p className="text-sm text-slate-600 mt-1">
                No active org selected. Set a default orgId in your user profile or in the app flow.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 p-8">
        <div className="max-w-3xl mx-auto text-slate-600">Loading libraries...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-8 pb-20">
      {/* MODALS */}
      <LibraryWizard
        orgId={activeOrgId}
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSave={handleSaveLibrary}
        isLoading={saving}
        initialData={editingLib}
      />

      {libraryToDelete && (
        <DeleteSafetyModal
          isOpen={isDeleteModalOpen}
          onClose={() => setIsDeleteModalOpen(false)}
          onConfirm={confirmDelete}
          libraryName={libraryToDelete.name}
          isLoading={deleting}
        />
      )}

      <div className="max-w-7xl mx-auto">
        {/* HEADER */}
        <div className="flex flex-col md:flex-row justify-between items-end mb-10 gap-4">
          <div>
            <div className="flex items-center space-x-3 mb-2">
              <div className="p-3 bg-slate-900 rounded-xl shadow-lg shadow-slate-900/20">
                <Settings className="w-6 h-6 text-white" />
              </div>
              <h1 className="text-3xl font-black text-slate-900 tracking-tight">Library Administration</h1>
            </div>
            <p className="text-slate-500 font-medium max-w-xl text-sm leading-relaxed">
              Configure document repositories, define dynamic metadata schemas, and control role-based access per org.
            </p>
            <p className="text-[11px] text-slate-400 mt-2 font-mono">
              orgId: <span className="text-slate-600">{activeOrgId}</span>
            </p>
          </div>

          <div className="flex items-center gap-3 w-full md:w-auto">
            <input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search libraries..."
              className="w-full md:w-72 px-4 py-2 rounded-xl border border-slate-200 bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10"
            />
            <select
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as "name" | "recent")}
              className="px-3 py-2 rounded-xl border border-slate-200 bg-white shadow-sm"
            >
              <option value="recent">Recent</option>
              <option value="name">Name</option>
            </select>
            <button
              onClick={openCreate}
              className="px-4 py-2 rounded-xl bg-slate-900 text-white font-bold shadow hover:bg-slate-800"
            >
              New Library
            </button>
          </div>
        </div>

        {/* LIST */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredLibraries.map((lib) => (
            <div
              key={lib.id}
              className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm hover:shadow-md transition"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-lg font-black text-slate-900 truncate">{lib.name}</div>
                  <div className="text-sm text-slate-600 mt-1 line-clamp-2">{lib.description}</div>
                  <div className="text-[11px] text-slate-400 mt-3 font-mono truncate">
                    libraryId: {lib.id}
                  </div>
                </div>

                <div className="flex flex-col gap-2 shrink-0">
                  <button
                    onClick={() => router.push(`/documents/${lib.id}`)}
                    className="px-3 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-sm font-bold"
                  >
                    Open
                  </button>
                  <button
                    onClick={() => openEdit(lib)}
                    className="px-3 py-2 rounded-xl bg-slate-900 text-white hover:bg-slate-800 text-sm font-bold"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => initiateDelete(lib)}
                    className="px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-red-700 hover:bg-red-100 text-sm font-bold"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}

          {filteredLibraries.length === 0 && (
            <div className="col-span-full bg-white border border-slate-200 rounded-2xl p-10 text-center text-slate-600">
              No libraries found for this org.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

