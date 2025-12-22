export default function AdminHeader() {
  const handleLogout = async () => {
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
      });

      if (response.ok) {
        window.location.href = '/login';
      }
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };
  return (
    <header className="bg-byuNavy text-white p-4 md:p-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold">AI Therapist Admin Panel</h1>
          <p className="text-sm text-byuLightBlue mt-1">
            HIPAA-Redacted Audit Platform - All data is automatically redacted per Safe Harbor rules
          </p>
        </div>
        <button onClick={handleLogout} className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-full text-sm font-semibold w-full sm:w-auto text-center" title="Logout">Logout</button>
      </div>
    </header>
  );
}
