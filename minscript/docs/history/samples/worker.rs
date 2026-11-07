
// ============================================================================
// MINSCRIPT ASYNC & WORK-STEALING RUNTIME: ARCHITECTURE REFERENCE SHEET
// ============================================================================
// 
// 1. USER-FACING SYNTAX (Zero 'spawn' keyword, calling an async function 
//    automatically packages and enqueues it to the work-stealing queue).
// 2. BEHIND-THE-SCENES RUNTIME LOWERING (Task structs, state machine continuations,
//    and per-thread local deques).
// ============================================================================

async fun fetch_record(id: int32): String {
    // [BEHIND THE SCENES: State 0 (Initial Entry)]
    // When execution hits an uncompleted await, the compiler splits this function 
    // into a state-machine continuation struct and pauses execution.
    let raw = await database_query(id) // Suspends and yields if socket isn't ready
    
    // [BEHIND THE SCENES: State 1 (Resumption)]
    // When the database promise resolves, the scheduler pushes this continuation 
    // back onto a worker queue. Execution resumes right here.
    return raw.to_upper()
}

fun main() {
    // ------------------------------------------------------------------------
    // BEHIND-THE-SCENES RUNTIME ARCHITECTURE IMPLEMENTATION NOTES:
    // ------------------------------------------------------------------------
    // 
    // A. THE PROMISE HANDLE (Allocated on caller invocation):
    //    struct Promise {
    //        atomic_int state; // Pending, Completed, Failed
    //        void* result_ptr;
    //        Mutex waker_lock;
    //        Task* awaiting_task;
    //    };
    //
    // B. THE TASK (COROUTINE) STRUCT (Managed by the work-stealing scheduler):
    //    typedef struct Task {
    //        void (*resume_fn)(struct Task* self); // Jump target for state machine
    //        Promise* promise;                     // Linked return promise
    //        uint8_t frame_data[];                 // Captured lexical scope / locals
    //    };
    //
    // C. WORK-STEALING LOCAL DEQUE (Per-OS Thread):
    //    typedef struct WorkerQueue {
    //        Task* tasks[1024];
    //        uint32_t head, tail;
    //        pthread_mutex_t lock;
    //    };
    // ------------------------------------------------------------------------

    // Calling `fetch_record(42)` does NOT run inline on the main thread.
    // 1. It allocates a `Promise` and a `Task` struct.
    // 2. It IMMEDIATELY pushes the Task to the current thread's local `WorkerQueue`.
    // 3. It returns the `Promise<String>` handle instantly to the caller.
    let p1 = fetch_record(42)
    let p2 = fetch_record(99)

    // Other threads in the worker pool steal and execute p1 and p2 concurrently.

    // Awaiting a promise blocks or yields the current task until resolved.
    // If already complete, returns instantly with zero overhead.
    let result = await p1
}






// ============================================================================
// MINSCRIPT WORK-STEALING RUNTIME PSEUDOCODE
// ============================================================================

struct Task {
    void (*resume_fn)(Task* self);
    Promise* promise;
    // captured stack frame / variables below...
};

struct WorkerQueue {
    Task* buffer[256];
    _Atomic uint32_t head;
    _Atomic uint32_t tail;
    Mutex lock; // protects stealing/resizing
};

struct Runtime {
    WorkerQueue** workers;
    uint32_t worker_count;
    _Atomic bool running;
};

// ----------------------------------------------------------------------------
// 1. PUSH TASK (Called when an async function is invoked)
// ----------------------------------------------------------------------------
void runtime_schedule_task(Runtime* rt, Task* task) {
    // Get current thread's local queue (via thread-local storage TLS)
    WorkerQueue* q = current_worker_queue();
    
    uint32_t tail = atomic_load(&q->tail);
    q->buffer[tail % 256] = task;
    atomic_store(&q->tail, tail + 1);
}

// ----------------------------------------------------------------------------
// 2. THE WORKER EXECUTION LOOP
// ----------------------------------------------------------------------------
void worker_main_loop(Runtime* rt, uint32_t worker_id) {
    WorkerQueue* self_q = rt->workers[worker_id];

    while (atomic_load(&rt->running)) {
        Task* task = NULL;

        // Step 1: Try pop from local queue (LIFO)
        uint32_t tail = atomic_load(&self_q->tail);
        uint32_t head = atomic_load(&self_q->head);

        if (tail > head) {
            // Local work exists
            tail--;
            atomic_store(&self_q->tail, tail);
            task = self_q->buffer[tail % 256];
        }

        // Step 2: If local queue is empty, try to STEAL from a victim
        if (!task) {
            task = try_steal_work(rt, worker_id);
        }

        // Step 3: If still no work, sleep/park briefly
        if (!task) {
            cpu_relax(); // or pthread_cond_wait on idle signal
            continue;
        }

        // Step 4: Execute the task
        // This runs the coroutine state-machine until it yields or completes
        task->resume_fn(task);
    }
}

// ----------------------------------------------------------------------------
// 3. WORK STEALING LOGIC (FIFO from victim's head)
// ----------------------------------------------------------------------------
Task* try_steal_work(Runtime* rt, uint32_t my_id) {
    // Pick a random victim thread (different from self)
    uint32_t victim_id = random_range(0, rt->worker_count - 1);
    if (victim_id == my_id) return NULL;

    WorkerQueue* victim_q = rt->workers[victim_id];

    // Lock victim queue to prevent race conditions during steal
    lock(&victim_q->lock);

    uint32_t v_head = atomic_load(&victim_q->head);
    uint32_t v_tail = atomic_load(&victim_q->tail);

    Task* stolen_task = NULL;

    if (v_tail > v_head) {
        // Grab the oldest task from the head (FIFO)
        stolen_task = victim_q->buffer[v_head % 256];
        atomic_store(&victim_q->head, v_head + 1);
    }

    unlock(&victim_q->lock);
    return stolen_task;
}





Task* try_steal_work_batch(Runtime* rt, uint32_t my_id, WorkerQueue* self_q) {
    uint32_t victim_id = random_range(0, rt->worker_count - 1);
    if (victim_id == my_id) return NULL;

    WorkerQueue* victim_q = rt->workers[victim_id];

    lock(&victim_q->lock);

    uint32_t v_head = atomic_load(&victim_q->head);
    uint32_t v_tail = atomic_load(&victim_q->tail);
    uint32_t count = v_tail > v_head ? v_tail - v_head : 0;

    if (count <= 1) {
        // Victim has 0 or 1 task; not worth stealing
        unlock(&victim_q->lock);
        return NULL;
    }

    // STEAL HALF OF THE TASKS
    uint32_t steal_count = count / 2;
    Task* first_stolen = NULL;

    for (uint32_t i = 0; i < steal_count; i++) {
        Task* t = victim_q->buffer[(v_head + i) % 256];
        
        if (i == 0) {
            first_stolen = t; // This one goes straight to the executing thread
        } else {
            // The rest are pushed directly into OUR local queue!
            uint32_t my_tail = atomic_load(&self_q->tail);
            self_q->buffer[my_tail % 256] = t;
            atomic_store(&self_q->tail, my_tail + 1);
        }
    }

    // Advance the victim's head past all stolen tasks
    atomic_store(&victim_q->head, v_head + steal_count);

    unlock(&victim_q->lock);
    return first_stolen;
}






// Example: The compiler-generated struct for an async function
typedef struct FetchTaskFrame {
    // 1. State machine instruction pointer (which 'await' we are paused at)
    int state_pc; 

    // 2. Local variables that must survive across the await boundary
    int32_t user_id;
    MinString url;
    HttpResponse response; // Used after the await

    // 3. Linked Promise reference
    Promise* promise;
} FetchTaskFrame;


// Conceptual view of what the C emitter generates for an async function
void my_async_task_resume(Task* task) {
    // Unpack the persistent stack frame/backpack
    AsyncFrame* frame = (AsyncFrame*)task->frame_data;

    switch (frame->state_pc) {
        case 0: goto LABEL_START;
        case 1: goto LABEL_AFTER_AWAIT_1;
        case 2: goto LABEL_AFTER_AWAIT_2;
    }

    LABEL_START:
    // ... code before first await ...
    frame->state_pc = 1;
    // Save suspension point and yield back to scheduler...
    return;

    LABEL_AFTER_AWAIT_1:
    // Resumed here! Arguments and local variables are still sitting in `frame`
    // ... rest of the code ...
}

