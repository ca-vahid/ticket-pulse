export default function StatCard({ title, value, icon: Icon, color = 'blue' }) {
  const colorClasses = {
    blue: 'bg-blue-100 dark:bg-blue-500/20 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-500/30',
    green: 'bg-green-100 dark:bg-green-500/20 text-green-800 dark:text-green-200 border-green-200 dark:border-green-500/30',
    red: 'bg-red-100 dark:bg-red-500/20 text-red-800 dark:text-red-200 border-red-200 dark:border-red-500/30',
    yellow: 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-800 dark:text-yellow-200 border-yellow-200 dark:border-yellow-500/30',
    purple: 'bg-purple-100 dark:bg-purple-500/20 text-purple-800 dark:text-purple-200 border-purple-200 dark:border-purple-500/30',
  };

  const colorClass = colorClasses[color] || colorClasses.blue;

  return (
    <div className={`${colorClass} border-2 rounded-lg p-4`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm opacity-80 mb-1">{title}</p>
          <p className="text-3xl font-bold">{value}</p>
        </div>
        {Icon && (
          <div className="bg-card rounded-full p-3">
            <Icon className="w-6 h-6" />
          </div>
        )}
      </div>
    </div>
  );
}
