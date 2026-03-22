export default function ExportsPage() {
  const mockExports = [
    { id: 'exp_001', createdAt: '2026-03-21', recordCount: 48, status: 'Ready' },
    { id: 'exp_002', createdAt: '2026-03-20', recordCount: 102, status: 'Ready' },
  ];

  return (
    <section>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-[#1a2233]">CSV Exports</h1>
        <button className="bg-amber-500 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-amber-400 transition">New Export</button>
      </div>
      <div className="border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
            <tr>
              <th className="px-6 py-3 text-left">Export ID</th>
              <th className="px-6 py-3 text-left">Date</th>
              <th className="px-6 py-3 text-left">Records</th>
              <th className="px-6 py-3 text-left">Status</th>
              <th className="px-6 py-3 text-left">Download</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-100">
            {mockExports.map((exp) => (
              <tr key={exp.id} className="hover:bg-gray-50 transition">
                <td className="px-6 py-4 font-mono text-xs text-gray-500">{exp.id}</td>
                <td className="px-6 py-4">{exp.createdAt}</td>
                <td className="px-6 py-4">{exp.recordCount}</td>
                <td className="px-6 py-4"><span className="text-green-600 font-medium">{exp.status}</span></td>
                <td className="px-6 py-4"><a href="#" className="text-amber-600 hover:underline">Download</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
