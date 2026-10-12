import { motion } from 'framer-motion';

export const Greeting = () => {
  return (
    <div
      key="overview"
      className="mx-auto flex size-full max-w-3xl flex-col justify-center px-4 mb-6"
    >
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 10 }}
        className="font-semibold text-lg md:text-xl text-center"
      >
        Press Release Generator
      </motion.div>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 10 }}
        transition={{ delay: 0.1 }}
        className="text-sm text-muted-foreground text-center mt-2"
      >
        Generate MS NOW Nielsen ratings press releases, or ask any ratings question
      </motion.div>
    </div>
  );
};
